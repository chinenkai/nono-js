// nono-directives.js - 处理 n-* 指令及属性绑定

(function () {
    // 确认核心库 NueCore 已加载
    if (!window.NueCore) {
        console.error("指令错误：核心库 (nono-core.js) 必须先加载！");
        return;
    }
    // console.log("指令系统：nono-directives.js 加载中..."); // 启动日志可以保留或移除

    // 从核心库获取所需函数
    const { createEffect, compileNode, createSignal } = window.NueCore;

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
        const context = Object.create(scope); // 继承组件作用域
        Object.assign(context, additionalContext); // 合并额外上下文

        try {
            // 使用 Function 构造器和 'with' 语句在受控环境中执行表达式
            const evaluatorFunction = new Function("context", `with(context) { return (${expression}); }`);
            return evaluatorFunction.call(null, context);
        } catch (error) {
            console.error(`指令错误：执行表达式 "${expression}" 时出错:`, error, "\n作用域:", scope, "\n额外上下文:", additionalContext);
            throw error; // 重新抛出，以便上层 createEffect 等可以捕获
        }
    }

    /**
     * 尝试将表达式解析为可写入的 Signal 访问器函数。
     * 主要用于 n-model 指令。
     * @param {string} expression - 通常是 Signal 的名称字符串。
     * @param {object} scope - 组件作用域。
     * @returns {Function | null} Signal 访问器函数，或在失败时返回 null。
     */
    function getSignalAccessor(expression, scope) {
        try {
            const potentialSignal = evaluateExpression(expression, scope);
            // 基本检查：是函数且参数数量符合 Signal 特征
            if (typeof potentialSignal === "function" && potentialSignal.length <= 1) {
                return potentialSignal;
            }
        } catch (error) {
            // 忽略求值错误，因为表达式可能不是直接的 Signal 引用
        }
        console.warn(`指令警告：无法将表达式 "${expression}" 解析为可写的 Signal。`);
        return null;
    }

    // ==================================
    // 指令处理器实现
    // ==================================

    /**
     * 处理 n-if 指令：根据条件动态添加或移除元素。
     * @param {Element} element - 带有 n-if 属性的元素。
     * @param {string} expression - n-if 的条件表达式。
     * @param {object} scope - 组件作用域。
     * @param {Function} compileFn - 核心编译函数 (NueCore.compileNode)。
     * @param {object} directiveHandlers - 指令处理器集合。
     * @param {string} componentName - 当前组件名，用于日志。
     */
    function handleNIf(element, expression, scope, compileFn, directiveHandlers, componentName) {
        const parent = element.parentNode;
        const anchor = document.createComment(` n-if anchor: ${expression} `); // 注释锚点
        if (parent) {
            parent.replaceChild(anchor, element);
        } else {
            console.warn(`指令警告：[${componentName}] n-if 元素无父节点，可能无法正确处理。`);
            return;
        }

        let currentElement = null; // 当前显示的元素实例
        let isCompiledOnce = false; // 标记模板是否已编译过一次

        createEffect(() => {
            let condition = false;
            try {
                condition = !!evaluateExpression(expression, scope);
            } catch (error) {
                // evaluateExpression 内部已打印错误，这里仅设置默认条件
                condition = false;
            }

            if (condition) {
                if (!currentElement) {
                    // 条件为真且元素未显示
                    const clone = element.cloneNode(true);
                    clone.removeAttribute("n-if"); // 移除指令属性，防止无限递归

                    if (!isCompiledOnce) {
                        // 仅在首次创建时编译
                        compileFn(clone, scope, directiveHandlers, componentName);
                        isCompiledOnce = true;
                    }
                    anchor.parentNode?.insertBefore(clone, anchor.nextSibling);
                    currentElement = clone;
                }
            } else {
                if (currentElement) {
                    // 条件为假且元素已显示
                    // NueCore.cleanupAndRemoveNode(currentElement); // 使用核心库的清理函数
                    currentElement.parentNode?.removeChild(currentElement); // 简单移除
                    currentElement = null;
                }
            }
        });
    }

    /**
     * 处理 n-for 指令：根据数组或可迭代对象渲染列表，支持基于 key 的高效更新。
     * @param {Element} templateElement - 作为模板的元素 (例如，带有 n-for 的 <li>)。
     * @param {string} expression - n-for 表达式，如 "(item, index) in items" 或 "item in items"。
     * @param {object} scope - 组件作用域。
     * @param {Function} compileFn - 核心编译函数 (NueCore.compileNode)，用于编译列表项的内容。
     * @param {object} directiveHandlers - 指令处理器集合 (用于递归编译)。
     * @param {string} componentName - 当前组件名，用于日志和生成更详细的组件路径。
     */
    function handleNFor(templateElement, expression, scope, compileFn, directiveHandlers, componentName) {
        const parentOfTemplate = templateElement.parentNode; // n-for 模板元素在 DOM 中原始的父节点

        // 锚点注释节点，用于标记 n-for 列表在 DOM 中的开始位置
        const anchor = document.createComment(` n-for anchor for: ${expression} `);

        if (parentOfTemplate) {
            // 用锚点替换掉原始的 n-for 模板元素
            // 原始模板元素将不再直接参与渲染，而是作为克隆的源
            parentOfTemplate.replaceChild(anchor, templateElement);
        } else {
            // 这种情况理论上不应该在一个正常的、已挂载的组件中对顶层 n-for 发生。
            // 如果 templateElement 是在内存中创建的片段的一部分，则可能没有父节点。
            // 对于深层嵌套的 n-for，如果外层 compileNode 正在处理一个游离的克隆节点，
            // 那么这个警告也可能出现。但我们主要关注顶层 n-for 的情况。
            console.error(`指令错误：[${componentName}] n-for 模板元素 <${templateElement.tagName}> 无父节点，无法放置渲染锚点。列表可能无法渲染。`);
            return; // 无法继续，因为没有地方插入锚点和列表项
        }

        // 解析 n-for 表达式: (item, index) in iterable or item in iterable
        const match = expression.match(/^\s*\(?\s*([a-zA-Z0-9_]+)\s*(?:,\s*([a-zA-Z0-9_]+)\s*)?\)?\s+in\s+(.+)$/);
        if (!match) {
            console.error(`指令错误：[${componentName}] 无效的 n-for 表达式: "${expression}"`);
            anchor.textContent = `[n-for 错误: 无效表达式 "${expression}"]`;
            // 尝试将原始模板元素放回去，以避免页面因指令错误而完全空白该区域
            if (anchor.parentNode) anchor.parentNode.replaceChild(templateElement, anchor);
            return;
        }

        const itemAlias = match[1]; // 迭代项的别名，如 "item"
        const indexAlias = match[2]; // 迭代索引的别名，如 "index" (可选)
        const iterableExpression = match[3].trim(); // 提供可迭代对象的表达式，如 "items()"

        // 提取 Key 表达式
        let keyExpression = templateElement.getAttribute(":key") || templateElement.getAttribute("key");
        if (keyExpression) {
            // 从原始模板元素上移除 key 属性，因为它仅用于 n-for 的 diff 逻辑，
            // 不应该出现在每个渲染出来的列表项的属性上 (除非开发者明确也绑定了 :key)
            templateElement.removeAttribute(":key");
            templateElement.removeAttribute("key");
        } else {
            console.warn(`指令警告：[${componentName}] n-for 表达式 "${expression}" 未指定 ':key'。将使用数组索引作为 key，这可能导致在列表项重排序或非末尾增删时性能不佳或状态丢失。`);
        }

        // 存储当前渲染的节点条目，映射: key -> { node, itemSignal, indexSignal, localScope, key }
        let keyedNodeEntries = new Map();

        // 使用 createEffect 监听可迭代对象的变化，并在变化时重新渲染列表
        NueCore.createEffect(() => {
            // console.log(`指令信息：[${componentName}] n-for effect for "${iterableExpression}"`);
            let newItemsArray; // 本次渲染需要的数据列表
            try {
                const iterable = directiveHandlers.evaluateExpression(iterableExpression, scope);
                if (iterable == null) {
                    // 处理 null 或 undefined
                    newItemsArray = [];
                } else if (typeof iterable[Symbol.iterator] === "function") {
                    // 检查是否可迭代
                    newItemsArray = Array.from(iterable);
                } else {
                    console.warn(`指令警告：[${componentName}] n-for 表达式 "${iterableExpression}" 的结果不是可迭代对象。实际值:`, iterable);
                    newItemsArray = [];
                }
            } catch (error) {
                console.error(`指令错误：[${componentName}] n-for 计算可迭代对象 "${iterableExpression}" 失败。`, error);
                newItemsArray = [];
            }

            const newKeyedNodeEntries = new Map(); // 用于构建本次渲染结果的 Map
            const nodesToRenderInOrder = []; // 按新顺序排列的 DOM 节点，用于后续的 DOM 操作
            const oldKeys = new Set(keyedNodeEntries.keys()); // 记录上一次渲染的所有 keys，用于检测需要删除的项

            // --- 步骤 1: 遍历新数据，进行 Diff，创建或复用节点 ---
            newItemsArray.forEach((currentItemData, currentIndex) => {
                let currentItemKey; // 当前迭代项的 key
                if (keyExpression) {
                    // 如果指定了 key 表达式 (例如 :key="item().id")
                    // 为 key 的求值创建一个临时的、非响应式的上下文
                    const keyEvalContext = Object.create(scope); // 继承父作用域以访问其方法或全局变量

                    // 关键：itemAlias (如 "item") 映射为一个返回原始数据的函数，以匹配 item().id 这样的表达式
                    keyEvalContext[itemAlias] = function () {
                        return currentItemData;
                    };
                    if (indexAlias) {
                        // indexAlias (如 "index") 也映射为一个返回当前索引的函数
                        keyEvalContext[indexAlias] = function () {
                            return currentIndex;
                        };
                    }

                    try {
                        currentItemKey = String(directiveHandlers.evaluateExpression(keyExpression, keyEvalContext));
                    } catch (e) {
                        console.error(`指令错误：[${componentName}] 计算 n-for 的 key 表达式 "${keyExpression}" 失败 for item:`, currentItemData, "\n临时上下文:", keyEvalContext, e);
                        currentItemKey = `__error_key_at_index_${currentIndex}__`; // 出错时给一个基于索引的唯一 key
                    }
                } else {
                    // 如果没有指定 key，则回退到使用数组索引作为 key (字符串化)
                    currentItemKey = String(currentIndex);
                }

                oldKeys.delete(currentItemKey); // 此 key 存在于新列表中，从“待删除旧 keys 集合”中移除

                let entry = keyedNodeEntries.get(currentItemKey); // 尝试从上次渲染的条目中获取

                if (entry) {
                    // --- 情况 A: 复用现有节点 (key 匹配成功) ---
                    entry.itemSignal(currentItemData); // 更新该项的 item Signal 的值
                    if (entry.indexSignal) {
                        // 如果使用了 index 别名
                        entry.indexSignal(currentIndex); // 更新该项的 index Signal 的值
                    }
                    // entry.localScope 中的 item 和 index 已经是 Signal，它们的值已通过上面的调用更新。
                    // entry.node 不需要重新编译，因为其内部的绑定依赖于 itemSignal 和 indexSignal。
                } else {
                    // --- 情况 B: 创建新节点 (key 是全新的，或之前不存在) ---
                    const clone = templateElement.cloneNode(true); // 克隆原始模板元素 (例如 <li>)

                    // 关键修复：从克隆体上移除 n-for 指令属性本身！
                    // 否则，当 compileFn 处理这个 clone 时，会再次遇到 n-for 并错误地递归调用 handleNFor，
                    // 导致之前提到的 "无父节点" 警告，因为此时 clone 是游离的。
                    clone.removeAttribute("n-for");

                    // 为这个列表项创建一个新的独立作用域，继承自父组件作用域
                    const iterationScope = Object.create(scope);
                    const itemSignal = NueCore.createSignal(currentItemData); // item 数据是响应式的
                    iterationScope[itemAlias] = itemSignal; // 在模板中通过 item() 访问

                    let indexSignal = null;
                    if (indexAlias) {
                        indexSignal = NueCore.createSignal(currentIndex); // index 也是响应式的
                        iterationScope[indexAlias] = indexSignal; // 在模板中通过 index() 访问
                    }

                    // 编译新克隆出来的列表项节点及其所有子内容
                    // 使用 iterationScope，这样列表项内部的绑定可以访问到 item 和 index
                    // componentName 也传递下去，用于更详细的日志/错误追踪
                    const itemComponentName = `${componentName} [n-for item key: ${currentItemKey}]`;
                    compileFn(clone, iterationScope, directiveHandlers, itemComponentName);

                    // 创建新的节点条目
                    entry = {
                        node: clone, // 编译好的 DOM 节点
                        itemSignal,
                        indexSignal,
                        localScope: iterationScope, // 该项的独立作用域
                        key: currentItemKey,
                    };
                }
                nodesToRenderInOrder.push(entry.node); // 将节点按新顺序收集起来
                newKeyedNodeEntries.set(currentItemKey, entry); // 将条目存入新的 Map
            });

            // --- 步骤 2: 移除不再需要的旧节点 ---
            // 此时 oldKeys 集合中剩下的都是在新数据列表中不再存在的 key
            oldKeys.forEach((keyToRemove) => {
                const entryToRemove = keyedNodeEntries.get(keyToRemove);
                if (entryToRemove && entryToRemove.node) {
                    // console.log(`指令信息：[${componentName}] n-for 正在移除 key 为 "${keyToRemove}" 的节点`);
                    NueCore.cleanupAndRemoveNode(entryToRemove.node); // 使用核心库的清理函数，确保组件卸载等逻辑执行
                }
            });

            // --- 步骤 3: 更新 DOM 顺序 ---
            // 遍历 nodesToRenderInOrder (已按新数据顺序排列的节点)，
            // 确保它们在 DOM 中也以这个顺序排列在 anchor 之后。
            // 这个过程会处理节点的移动和新节点的插入。
            let currentPositionMarker = anchor; // DOM 操作的参考点，初始为列表的起始锚点
            const parentOfAnchor = anchor.parentNode; // 获取锚点的父节点，所有列表项都将插入到这里

            if (!parentOfAnchor) {
                // 这种情况非常罕见，意味着锚点在渲染过程中被移除了，列表无法更新。
                console.error(`指令致命错误：[${componentName}] n-for 的渲染锚点已从 DOM 中移除，无法更新列表。`);
                return;
            }

            nodesToRenderInOrder.forEach((nodeToPlace) => {
                // 如果 nodeToPlace 的前一个兄弟不是 currentPositionMarker，
                // 或者 nodeToPlace 根本不在这个父节点下 (新创建的节点)，
                // 则需要将其插入/移动到 currentPositionMarker 之后。
                if (nodeToPlace.parentNode !== parentOfAnchor || nodeToPlace.previousSibling !== currentPositionMarker) {
                    parentOfAnchor.insertBefore(nodeToPlace, currentPositionMarker.nextSibling);
                }
                currentPositionMarker = nodeToPlace; // 更新标记为刚处理（或确认位置正确）的节点
            });

            // 更新存储的节点条目，为下一次 diff 做准备
            keyedNodeEntries = newKeyedNodeEntries;
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
        createEffect(() => {
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
        const originalDisplay = element.style.display === "none" ? "" : element.style.display;
        createEffect(() => {
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
        const inputType = element.type?.toLowerCase();
        const signalAccessor = getSignalAccessor(expression, scope);

        if (!signalAccessor) {
            console.error(`指令错误：[${componentName}] n-model="${expression}" 无法绑定，未解析为可写 Signal。`);
            element.style.outline = "2px solid red"; // 视觉提示错误
            return;
        }

        // 1. 从 Signal 更新视图 (Model -> View)
        createEffect(() => {
            const value = signalAccessor();
            if (tagName === "input") {
                if (inputType === "checkbox") element.checked = !!value;
                else if (inputType === "radio")
                    element.checked = value == element.value; // 松散比较
                else if (element.value !== String(value ?? "")) element.value = String(value ?? "");
            } else if ((tagName === "select" || tagName === "textarea") && element.value !== String(value ?? "")) {
                element.value = String(value ?? "");
            }
        });

        // 2. 从视图更新 Signal (View -> Model)
        const eventName = tagName === "select" || inputType === "checkbox" || inputType === "radio" ? "change" : "input";
        element.addEventListener(eventName, (event) => {
            const target = event.target;
            let newValue;
            if (inputType === "checkbox") newValue = target.checked;
            else if (inputType === "radio") {
                if (!target.checked) return; // 只处理选中的 radio
                newValue = target.value;
            } else {
                newValue = target.value;
            }
            try {
                signalAccessor(newValue);
            } catch (error) {
                //理论上不应发生，因为 signalAccessor 是函数
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
        createEffect(() => {
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
                if (typeof value === "string") classString = value;
                else if (Array.isArray(value)) classString = value.filter(Boolean).join(" ");
                else if (typeof value === "object" && value !== null) {
                    classString = Object.keys(value)
                        .filter((key) => value[key])
                        .join(" ");
                }
                // 注意: element.className 会覆盖所有现有 class。
                // 更精细的 class 管理需要追踪由指令添加的 class。
                element.className = classString;
            } else if (attrName === "style") {
                // 支持字符串或对象形式的 style 绑定
                if (typeof value === "string") element.style.cssText = value;
                else if (typeof value === "object" && value !== null) {
                    element.style.cssText = ""; // 清除旧样式再应用新样式
                    for (const key in value) {
                        if (value.hasOwnProperty(key)) element.style[key] = value[key];
                    }
                } else {
                    element.style.cssText = ""; // 无效值则清空
                }
            } else {
                // 其他常规属性和布尔属性
                if (typeof value === "boolean") {
                    // 布尔属性 (disabled, checked, etc.)
                    value ? element.setAttribute(attrName, "") : element.removeAttribute(attrName);
                } else if (value === null || value === undefined) {
                    element.removeAttribute(attrName);
                } else {
                    element.setAttribute(attrName, String(value));
                }
            }
        });
    }

    // ==================================
    // 暴露指令处理器集合
    // ==================================
    window.NueDirectives = {
        evaluateExpression, // 核心求值函数，供框架其他部分使用
        handleNIf,
        handleNFor,
        handleNHtml,
        handleNShow,
        handleNModel,
        handleAttributeBinding,
    };

    console.log("指令系统：nono-directives.js 加载完成。");
})();
