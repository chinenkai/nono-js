// nono-directives.js - 处理 n-* 指令及属性绑定

(function () {
    // 确认核心库 NueCore 已加载
    if (!window.NueCore) {
        console.error("指令错误：核心库 (nono-core.js) 必须先加载！");
        return;
    }
    // console.log("指令系统：nono-directives.js 加载中..."); // 调试时可以取消注释此行

    // 从核心库获取所需函数
    // 注意：在指令处理器内部，如果需要调用 NueCore 上的方法（如 cleanupAndRemoveNode），
    // 应该使用 window.NueCore.methodName() 来确保调用的是正确的实例。
    // createEffect, compileNode, createSignal 通常作为参数传入或在顶层作用域可用。
    // 此处假设 compileNode, createSignal 是通过某种方式在指令处理器的作用域中可用的，
    // 但为了明确，调用 NueCore 上的方法时最好使用 window.NueCore。
    // const { createEffect, compileNode, createSignal } = window.NueCore; // 这样写是OK的

    // ==================================
    // 核心工具函数
    // ==================================

    /**
     * 安全地在指定作用域内执行 JavaScript 表达式字符串。
     * @param {string} expression - 要求值的表达式字符串。
     * @param {object} scope - 组件的作用域对象 (包含响应式状态和方法)。
     * @param {object} [additionalContext={}] - 额外的上下文变量 (如 $event, item, index)。
     * @returns {*} 表达式的计算结果。
     * @throws 如果表达式计算出错。
     */
    function evaluateExpression(expression, scope, additionalContext = {}) {
        const context = Object.create(scope); // 继承组件作用域，避免直接修改原scope
        Object.assign(context, additionalContext); // 合并额外的上下文变量

        try {
            // 使用 Function 构造器和 'with' 语句在受控环境中执行表达式
            // 'with' 语句可以将一个对象的属性当作当前作用域的变量来访问
            const evaluatorFunction = new Function("context", `with(context) { return (${expression}); }`);
            return evaluatorFunction.call(null, context); // 使用 null 作为 this，因为表达式不应依赖特定的 this 上下文
        } catch (error) {
            console.error(`指令错误：执行表达式 "${expression}" 时出错:`, error, "\n作用域:", scope, "\n额外上下文:", additionalContext);
            throw error; // 重新抛出错误，以便上层调用者（如 createEffect）可以捕获
        }
    }

    /**
     * 尝试将表达式解析为可写入的 Signal 访问器函数。
     * 主要用于 n-model 指令。
     * @param {string} expression - 通常是 Signal 的名称字符串，例如 "textInput"。
     * @param {object} scope - 组件作用域。
     * @returns {Function | null} Signal 访问器函数，或在失败时返回 null。
     */
    function getSignalAccessor(expression, scope) {
        try {
            // 尝试在作用域中求值表达式，期望得到一个 Signal 函数
            const potentialSignal = evaluateExpression(expression, scope);
            // 基本检查：它必须是一个函数，并且参数数量符合 Signal 的特征（0个参数获取，1个参数设置）
            if (typeof potentialSignal === "function" && potentialSignal.length <= 1) {
                return potentialSignal;
            }
        } catch (error) {
            // 忽略求值错误，因为表达式可能不是一个直接的 Signal 引用 (例如，可能是更复杂的路径)
            // 错误已在 evaluateExpression 中打印
        }
        console.warn(`指令警告：无法将表达式 "${expression}" 解析为可写的 Signal。请确保它指向一个由 createSignal 创建的变量。`);
        return null;
    }

    // ==================================
    // 指令处理器实现
    // ==================================

    /**
     * 处理 n-if 指令：根据条件动态添加或移除元素。
     * @param {Element} element - 带有 n-if 属性的原始模板元素 (将被替换为锚点)。
     * @param {string} expression - n-if 的条件表达式。
     * @param {object} scope - 组件作用域。
     * @param {Function} compileFn - 核心编译函数 (NueCore.compileNode)，用于编译条件为真时创建的元素。
     * @param {object} directiveHandlers - 指令处理器集合 (主要用于 compileFn 内部递归调用)。
     * @param {string} componentName - 当前组件名，用于日志和调试。
     */
    function handleNIf(element, expression, scope, compileFn, directiveHandlers, componentName) {
        const parent = element.parentNode;
        // 创建一个注释节点作为锚点，标记 n-if 内容在 DOM 中的位置
        const anchor = document.createComment(` n-if anchor for: ${expression} `); 
        if (parent) {
            parent.replaceChild(anchor, element); // 用锚点替换原始的 n-if 元素
        } else {
            // 如果原始元素没有父节点 (例如，它是一个未附加到DOM的片段的一部分)，则指令可能无法正常工作
            console.warn(`指令警告：[${componentName}] n-if 元素 <${element.tagName}> 无父节点，可能无法正确处理。`);
            return;
        }

        let currentElement = null; // 存储当前因 n-if 为真而显示的元素实例

        // 使用 createEffect 监听条件表达式所依赖的 Signal 的变化
        window.NueCore.createEffect(() => { // 明确使用 window.NueCore.createEffect
            let condition = false; // 默认为 false，以防表达式计算出错
            try {
                condition = !!evaluateExpression(expression, scope); // 将表达式结果转为布尔值
            } catch (error) {
                // evaluateExpression 内部已打印错误，这里仅设置默认条件
                condition = false;
            }

            if (condition) { // 如果条件为真
                if (!currentElement) { // 并且当前没有元素显示 (即，之前条件为假或首次渲染)
                    // 克隆原始模板元素 (element 参数是原始的、未编译的模板)
                    const clone = element.cloneNode(true);
                    clone.removeAttribute("n-if"); // 从克隆体上移除 n-if 指令，防止无限递归编译

                    // console.log(`N-IF [${componentName}]: Compiling content for expression "${expression}"`);
                    // **关键：每次元素需要显示时，都必须编译这个新的克隆体**
                    // compileFn (即 NueCore.compileNode) 会处理 clone 内部的插值、其他指令等
                    compileFn(clone, scope, directiveHandlers, componentName);
                    
                    // 将编译好的克隆体插入到锚点之后
                    anchor.parentNode?.insertBefore(clone, anchor.nextSibling);
                    currentElement = clone; // 更新 currentElement 为新显示的元素
                }
            } else { // 如果条件为假
                if (currentElement) { // 并且当前有元素正在显示
                    // 使用核心库的清理函数移除元素，这会处理子组件卸载等逻辑
                    window.NueCore.cleanupAndRemoveNode(currentElement);
                    currentElement = null; // 重置 currentElement
                }
            }
        });
    }

    /**
     * 处理 n-for 指令：根据数组或可迭代对象渲染列表。
     * @param {Element} templateElement - 作为模板的元素 (例如，带有 n-for 的 <li>)。
     * @param {string} expression - n-for 表达式，如 "(item, index) in items" 或 "item in items"。
     * @param {object} scope - 组件作用域。
     * @param {Function} compileFn - 核心编译函数 (NueCore.compileNode)。
     * @param {object} directiveHandlers - 指令处理器集合。
     * @param {string} componentName - 当前组件名。
     */
    function handleNFor(templateElement, expression, scope, compileFn, directiveHandlers, componentName) {
        const parentOfTemplate = templateElement.parentNode;
        const anchor = document.createComment(` n-for anchor for: ${expression} `);

        if (parentOfTemplate) {
            parentOfTemplate.replaceChild(anchor, templateElement);
        } else {
            console.error(`指令错误：[${componentName}] n-for 模板元素 <${templateElement.tagName}> 无父节点，无法放置渲染锚点。列表可能无法渲染。`);
            return;
        }

        const match = expression.match(/^\s*\(?\s*([a-zA-Z0-9_]+)\s*(?:,\s*([a-zA-Z0-9_]+)\s*)?\)?\s+in\s+(.+)$/);
        if (!match) {
            console.error(`指令错误：[${componentName}] 无效的 n-for 表达式: "${expression}"`);
            anchor.textContent = `[n-for 错误: 无效表达式 "${expression}"]`;
            if (anchor.parentNode) anchor.parentNode.replaceChild(templateElement, anchor);
            return;
        }

        const itemAlias = match[1]; // 迭代项别名
        const indexAlias = match[2]; // 索引别名 (可选)
        const iterableExpression = match[3].trim(); // 提供可迭代对象的表达式

        let keyExpression = templateElement.getAttribute(":key") || templateElement.getAttribute("key");
        if (keyExpression) {
            templateElement.removeAttribute(":key");
            templateElement.removeAttribute("key");
        } else {
            console.warn(`指令警告：[${componentName}] n-for 表达式 "${expression}" 未指定 ':key'。将使用数组索引作为 key，这可能导致在列表项重排序或非末尾增删时性能不佳或状态丢失。`);
        }

        let keyedNodeEntries = new Map(); // 存储 key -> { node, itemSignal, indexSignal, localScope, key }

        window.NueCore.createEffect(() => { // 明确使用 window.NueCore.createEffect
            let newItemsArray;
            try {
                const iterable = directiveHandlers.evaluateExpression(iterableExpression, scope);
                if (iterable == null) { // 处理 null 或 undefined
                    newItemsArray = [];
                } else if (typeof iterable[Symbol.iterator] === "function") { // 检查是否可迭代
                    newItemsArray = Array.from(iterable);
                } else {
                    console.warn(`指令警告：[${componentName}] n-for 表达式 "${iterableExpression}" 的结果不是可迭代对象。实际值:`, iterable);
                    newItemsArray = [];
                }
            } catch (error) {
                console.error(`指令错误：[${componentName}] n-for 计算可迭代对象 "${iterableExpression}" 失败。`, error);
                newItemsArray = [];
            }

            const newKeyedNodeEntries = new Map();
            const nodesToRenderInOrder = [];
            const oldKeys = new Set(keyedNodeEntries.keys());

            newItemsArray.forEach((currentItemData, currentIndex) => {
                let currentItemKey;
                if (keyExpression) { // 如果指定了 key 表达式
                    const keyEvalContext = Object.create(scope);
                    keyEvalContext[itemAlias] = function () { return currentItemData; };
                    if (indexAlias) {
                        keyEvalContext[indexAlias] = function () { return currentIndex; };
                    }
                    try {
                        currentItemKey = String(directiveHandlers.evaluateExpression(keyExpression, keyEvalContext));
                    } catch (e) {
                        console.error(`指令错误：[${componentName}] 计算 n-for 的 key 表达式 "${keyExpression}" 失败 for item:`, currentItemData, "\n临时上下文:", keyEvalContext, e);
                        currentItemKey = `__error_key_at_index_${currentIndex}__`; // 出错时使用基于索引的 key
                    }
                } else { // 未指定 key，使用索引作为 key
                    currentItemKey = String(currentIndex);
                }

                oldKeys.delete(currentItemKey); // 此 key 存在于新列表中，从“待删除”集合中移除

                let entry = keyedNodeEntries.get(currentItemKey); // 尝试复用旧条目

                if (entry) { // 复用现有节点
                    entry.itemSignal(currentItemData); // 更新 item Signal
                    if (entry.indexSignal) {
                        entry.indexSignal(currentIndex); // 更新 index Signal (如果存在)
                    }
                } else { // 创建新节点
                    const clone = templateElement.cloneNode(true);
                    clone.removeAttribute("n-for"); // 从克隆体移除 n-for，防递归

                    const iterationScope = Object.create(scope); // 为列表项创建独立作用域
                    const itemSignal = window.NueCore.createSignal(currentItemData); // item 数据是响应式的
                    iterationScope[itemAlias] = itemSignal;

                    let indexSignal = null;
                    if (indexAlias) {
                        indexSignal = window.NueCore.createSignal(currentIndex); // index 也是响应式的
                        iterationScope[indexAlias] = indexSignal;
                    }

                    const itemComponentName = `${componentName} [n-for item key: ${currentItemKey}]`;
                    compileFn(clone, iterationScope, directiveHandlers, itemComponentName); // 编译新列表项

                    entry = {
                        node: clone,
                        itemSignal,
                        indexSignal,
                        localScope: iterationScope,
                        key: currentItemKey,
                    };
                }
                nodesToRenderInOrder.push(entry.node); // 按新顺序收集节点
                newKeyedNodeEntries.set(currentItemKey, entry); // 存入新 Map
            });

            // 移除不再需要的旧节点
            oldKeys.forEach((keyToRemove) => {
                const entryToRemove = keyedNodeEntries.get(keyToRemove);
                if (entryToRemove && entryToRemove.node) {
                    window.NueCore.cleanupAndRemoveNode(entryToRemove.node); // 使用核心清理函数
                }
            });

            // 更新 DOM 顺序
            let currentPositionMarker = anchor;
            const parentOfAnchor = anchor.parentNode;
            if (!parentOfAnchor) {
                console.error(`指令致命错误：[${componentName}] n-for 的渲染锚点已从 DOM 中移除，无法更新列表。`);
                return;
            }
            nodesToRenderInOrder.forEach((nodeToPlace) => {
                if (nodeToPlace.parentNode !== parentOfAnchor || nodeToPlace.previousSibling !== currentPositionMarker) {
                    parentOfAnchor.insertBefore(nodeToPlace, currentPositionMarker.nextSibling);
                }
                currentPositionMarker = nodeToPlace;
            });

            keyedNodeEntries = newKeyedNodeEntries; // 更新存储的节点条目
        });
    }

    /**
     * 处理 n-html 指令：将 HTML 字符串内容插入元素。
     * @param {Element} element - 目标元素。
     * @param {string} expression - 提供 HTML 内容的表达式。
     * @param {object} scope - 组件作用域。
     * @param {string} componentName - 当前组件名。
     */
    function handleNHtml(element, expression, scope, componentName) {
        window.NueCore.createEffect(() => { // 明确使用 window.NueCore.createEffect
            let htmlContent = "";
            try {
                htmlContent = String(evaluateExpression(expression, scope) ?? ""); // 处理 null/undefined
            } catch (error) {
                // evaluateExpression 内部已打印错误
                htmlContent = `<span style="color:red; font-style:italic;">n-html 错误: ${expression}</span>`;
            }
            // 警告：innerHTML 存在 XSS 风险，确保内容来源可信。
            element.innerHTML = htmlContent;
        });
    }

    /**
     * 处理 n-show 指令：通过 CSS display 控制元素显隐。
     * @param {Element} element - 目标元素。
     * @param {string} expression - 控制显隐的条件表达式。
     * @param {object} scope - 组件作用域。
     * @param {string} componentName - 当前组件名。
     */
    function handleNShow(element, expression, scope, componentName) {
        // 保存元素原始的 display 值 (如果不是 "none")
        const originalDisplay = element.style.display === "none" ? "" : element.style.display;
        window.NueCore.createEffect(() => { // 明确使用 window.NueCore.createEffect
            let condition = true; // 默认显示，以防表达式计算出错
            try {
                condition = !!evaluateExpression(expression, scope);
            } catch (error) {
                // evaluateExpression 内部已打印错误
            }
            element.style.display = condition ? originalDisplay : "none";
        });
    }

    /**
     * 处理 n-model 指令：实现表单元素的双向数据绑定。
     * @param {Element} element - 表单元素。
     * @param {string} expression - 绑定到作用域中 Signal 的表达式。
     * @param {object} scope - 组件作用域。
     * @param {string} componentName - 当前组件名。
     */
    function handleNModel(element, expression, scope, componentName) {
        const tagName = element.tagName.toLowerCase();
        const inputType = element.type?.toLowerCase(); // input 元素的 type 属性
        const signalAccessor = getSignalAccessor(expression, scope); // 获取 Signal 读写函数

        if (!signalAccessor) {
            console.error(`指令错误：[${componentName}] n-model="${expression}" 无法绑定，未解析为可写 Signal。`);
            element.style.outline = "2px solid red"; // 视觉提示绑定错误
            return;
        }

        // 1. 从 Signal 更新视图 (Model -> View)
        window.NueCore.createEffect(() => { // 明确使用 window.NueCore.createEffect
            const value = signalAccessor(); // 获取 Signal 的当前值
            if (tagName === "input") {
                if (inputType === "checkbox") {
                    element.checked = !!value;
                } else if (inputType === "radio") {
                    element.checked = (value == element.value); // 使用松散比较，因为 value 可能是数字或字符串
                } else if (element.value !== String(value ?? "")) { // 对于 text, password 等
                    element.value = String(value ?? ""); // 处理 null/undefined 为空字符串
                }
            } else if ((tagName === "select" || tagName === "textarea") && element.value !== String(value ?? "")) {
                element.value = String(value ?? "");
            }
        });

        // 2. 从视图更新 Signal (View -> Model)
        // 根据元素类型选择合适的事件 (input 通常更实时，change 用于 select, checkbox, radio)
        const eventName = (tagName === "select" || inputType === "checkbox" || inputType === "radio") ? "change" : "input";
        element.addEventListener(eventName, (event) => {
            const target = event.target;
            let newValue;
            if (inputType === "checkbox") {
                newValue = target.checked;
            } else if (inputType === "radio") {
                if (!target.checked) return; // 只处理被选中的 radio 按钮
                newValue = target.value;
            } else { // input[type=text], textarea, select
                newValue = target.value;
            }
            try {
                signalAccessor(newValue); // 更新 Signal 的值
            } catch (error) {
                // 理论上不应发生，因为 signalAccessor 是函数
                console.error(`指令错误：[${componentName}] 更新 n-model Signal "${expression}" 时出错:`, error);
            }
        });
    }

    /**
     * 处理属性绑定 (如 :id, :class, :style, :disabled)。
     * @param {Element} element - 目标元素。
     * @param {string} attrName - 要绑定的属性名 (不含 ':')。
     * @param {string} expression - 计算属性值的表达式。
     * @param {object} scope - 组件作用域。
     * @param {string} componentName - 当前组件名。
     */
    function handleAttributeBinding(element, attrName, expression, scope, componentName) {
        window.NueCore.createEffect(() => { // 明确使用 window.NueCore.createEffect
            let value;
            try {
                value = evaluateExpression(expression, scope);
            } catch (error) {
                // evaluateExpression 内部已打印错误
                value = null; // 出错时倾向于移除属性或设为安全值
            }

            if (attrName === "class") {
                // 支持字符串、数组、对象形式的 class 绑定
                let classString = "";
                if (typeof value === "string") {
                    classString = value;
                } else if (Array.isArray(value)) {
                    classString = value.filter(Boolean).join(" "); // 过滤掉假值并用空格连接
                } else if (typeof value === "object" && value !== null) {
                    classString = Object.keys(value)
                        .filter((key) => value[key]) // 只保留值为 true 的键
                        .join(" ");
                }
                // 注意: element.className 会覆盖所有现有 class。
                // 如果需要更精细的 class 管理 (例如，保留静态 class)，需要更复杂的逻辑。
                // 对于简单场景，直接赋值 className 是可行的。
                element.className = classString;
            } else if (attrName === "style") {
                // 支持字符串或对象形式的 style 绑定
                if (typeof value === "string") {
                    element.style.cssText = value; // 直接设置 cssText
                } else if (typeof value === "object" && value !== null) {
                    element.style.cssText = ""; // 清除旧样式再应用新样式
                    for (const key in value) {
                        if (value.hasOwnProperty(key)) {
                            element.style[key] = value[key]; // 逐个设置样式属性
                        }
                    }
                } else {
                    element.style.cssText = ""; // 无效值则清空样式
                }
            } else {
                // 其他常规属性和布尔属性
                if (typeof value === "boolean") {
                    // 对于布尔属性 (如 disabled, checked, readonly)，值为 true 时添加属性，false 时移除
                    value ? element.setAttribute(attrName, "") : element.removeAttribute(attrName);
                } else if (value === null || value === undefined) {
                    // 如果值为 null 或 undefined，则移除该属性
                    element.removeAttribute(attrName);
                } else {
                    // 其他情况，将值转为字符串并设置属性
                    element.setAttribute(attrName, String(value));
                }
            }
        });
    }

    // ==================================
    // 暴露指令处理器集合
    // ==================================
    window.NueDirectives = {
        evaluateExpression, // 核心求值函数，供框架其他部分（如 compileNode 中的插值处理）使用
        handleNIf,
        handleNFor,
        handleNHtml,
        handleNShow,
        handleNModel,
        handleAttributeBinding,
    };

    console.log("指令系统：nono-directives.js 加载完成。");
})();
