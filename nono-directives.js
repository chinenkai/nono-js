// nono-directives.js - 处理 n-* 指令及属性绑定

(function() {
    // 确认核心库 NueCore 已加载
    if (!window.NueCore) {
        console.error("核心库 (nono-core.js) 必须先加载！");
        return;
    }
    console.log("nono-directives.js 加载中...");

    // 从核心库获取所需函数
    const { createEffect, compileNode, createSignal } = window.NueCore; // compileNode 用于 n-if/n-for 内部递归编译

    // ==================================
    // 核心工具函数：表达式求值
    // ==================================

    /**
     * 安全地执行 JavaScript 表达式字符串。
     * @param {string} expression - 要求值的表达式字符串。
     * @param {object} scope - 组件的作用域对象 (包含响应式状态和方法)。
     * @param {object} [additionalContext={}] - 额外的上下文变量，例如 { $event: eventObject, item: loopItem, index: loopIndex }。
     * @returns {*} 表达式的计算结果。
     * @throws 如果表达式计算或访问作用域属性时出错。
     */
    function evaluateExpression(expression, scope, additionalContext = {}) {
        // 创建一个执行上下文，其原型链指向组件的 scope，
        // 并将 additionalContext 的属性作为自有属性添加，这样它们会优先被访问。
        const context = Object.create(scope);
        Object.assign(context, additionalContext);

        // 准备 Function 构造器的参数名和值
        const contextArgName = 'context'; // 在函数内部访问上下文的名称
        const argNames = [contextArgName];
        const argValues = [context];

        try {
            // 使用 'with' 语句将 context 对象添加到作用域链的顶部，
            // 使得表达式可以直接访问 scope 和 additionalContext 中的属性/方法。
            // 表达式需要被包裹在 return 语句中，以便 Function 返回其结果。
            // 使用 Function 构造器而不是 eval 来限制作用域并提高一点安全性（虽然 'with' 仍需谨慎）。
            const evaluatorFunction = new Function(...argNames, `with(${contextArgName}) { return (${expression}); }`);

            // 使用 .call(null, ...) 或 .apply(null, ...) 执行函数，
            // 第一个参数 null 表示不设置特定的 this 上下文（因为我们使用 with 来处理作用域）。
            return evaluatorFunction.call(null, ...argValues);
        } catch (error) {
            // 如果执行表达式时出错（例如，访问不存在的属性，语法错误等），
            // 打印详细错误信息并重新抛出，以便上层调用者（如 createEffect）可以捕获。
            console.error(`执行表达式 "${expression}" 时出错:`, error, '作用域:', scope, '额外上下文:', additionalContext);
            throw error; // 重新抛出错误，很重要！
        }
    }

    /**
     * 尝试将表达式解析为可以安全写入的 Signal。
     * 主要用于 n-model 更新。
     * @param {string} expression - 通常是 Signal 的名称，如 "count" 或 "form.name"。
     * @param {object} scope - 组件作用域。
     * @returns {Function | null} 返回 Signal 访问器函数，如果找不到或不是函数则返回 null。
     */
    function getSignalAccessor(expression, scope) {
        try {
            // 尝试直接求值，期望得到 Signal 函数
            const potentialSignal = evaluateExpression(expression, scope);
            if (typeof potentialSignal === 'function' && potentialSignal.length <= 1) {
                // 简单检查：是函数且参数数量<=1 (Signal 读取是0个参数，写入是1个)
                // 注意：这只是一个基本检查，不能完全保证它就是 createSignal 返回的函数
                return potentialSignal;
            }
        } catch (error) {
            // 求值失败或结果不是函数，则无法写入
            console.warn(`无法将表达式 "${expression}" 解析为可写的 Signal:`, error);
        }
        return null;
    }


    // ==================================
    // 指令处理器实现
    // ==================================

    /**
     * 处理 n-if 指令。
     * @param {Element} element - 带有 n-if 属性的元素。
     * @param {string} expression - n-if 的条件表达式。
     * @param {object} scope - 组件作用域。
     * @param {Function} compileFn - 核心编译函数 (compileNode)。
     * @param {object} directiveHandlers - 指令处理器集合 (自身)。
     * @param {string} componentName - 当前组件名，用于日志。
     */
    function handleNIf(element, expression, scope, compileFn, directiveHandlers, componentName) {
        const parent = element.parentNode;
        // 创建一个注释节点作为锚点，标记 n-if 的位置
        const anchor = document.createComment(` n-if: ${expression} `);
        parent?.replaceChild(anchor, element); // 用锚点替换原始元素

        let currentElement = null; // 存储当前显示的元素实例
        let isCompiled = false; // 标记元素是否已经被编译过

        createEffect(() => {
            let condition = false;
            try {
                // 计算条件表达式的值
                condition = !!evaluateExpression(expression, scope);
            } catch (error) {
                console.error(`[${componentName}] 计算 n-if 表达式 "${expression}" 出错:`, error);
                condition = false; // 出错时视为 false
            }

            if (condition) {
                // 条件为真，且元素尚未显示
                if (!currentElement) {
                    // 克隆原始元素节点（包含其所有子节点）
                    // 注意：此时 element 已经不在 DOM 树中，但我们仍然持有它的引用
                    const clone = element.cloneNode(true);
                    // **重要**: 移除克隆节点上的 n-if 属性，防止无限递归编译
                    clone.removeAttribute('n-if');

                    // **重要**: 编译这个克隆出来的节点及其子孙节点
                    // 这是必要的，因为原始元素可能包含其他指令或插值
                    // 只有在首次创建时编译一次
                    if (!isCompiled) {
                         // 使用传入的 compileFn (即 NueCore.compileNode)
                         compileFn(clone, scope, directiveHandlers, componentName);
                         isCompiled = true; // 标记已编译
                    }

                    // 将编译好的克隆节点插入到锚点之后
                    anchor.parentNode?.insertBefore(clone, anchor.nextSibling);
                    currentElement = clone; // 保存对当前显示元素的引用
                }
            } else {
                // 条件为假，且元素当前正在显示
                if (currentElement) {
                    // 从 DOM 中移除元素
                    currentElement.parentNode?.removeChild(currentElement);
                    currentElement = null; // 清除引用
                    // isCompiled 保持 true，如果条件再次变为 true，我们不需要重新编译，只需重新插入
                }
            }
        });
    }


    /**
     * 处理 n-for 指令。
     * @param {Element} templateElement - 带有 n-for 属性的元素 (作为模板)。
     * @param {string} expression - n-for 表达式，例如 "(item, index) in items"。
     * @param {object} scope - 组件作用域。
     * @param {Function} compileFn - 核心编译函数 (compileNode)。
     * @param {object} directiveHandlers - 指令处理器集合。
     * @param {string} componentName - 当前组件名，用于日志。
     */
    function handleNFor(templateElement, expression, scope, compileFn, directiveHandlers, componentName) {
        const parent = templateElement.parentNode;
        const anchor = document.createComment(` n-for: ${expression} `);
        parent?.replaceChild(anchor, templateElement);

        const match = expression.match(/^\s*\(?\s*([a-zA-Z0-9_]+)\s*(?:,\s*([a-zA-Z0-9_]+)\s*)?\)?\s+in\s+(.+)$/);
        if (!match) {
            console.error(`[${componentName}] 无效的 n-for 表达式: "${expression}"`);
            anchor.textContent = ` 无效的 n-for 表达式: ${expression} `;
            return;
        }

        const itemAlias = match[1];
        const indexAlias = match[2];
        const iterableExpression = match[3].trim();

        // *** 修改: renderedNodes 现在存储 { node, itemSignal, indexSignal, scope } ***
        let renderedNodes = [];

        createEffect(() => {
            // *** 添加日志，确认 effect 运行 ***
            console.log(`[${componentName}] n-for effect running for "${iterableExpression}"`);

            let items = [];
            try {
                const iterable = evaluateExpression(iterableExpression, scope);
                items = Array.isArray(iterable) ? iterable : (iterable ? Array.from(iterable) : []);
            } catch (error) {
                console.error(`[${componentName}] 计算 n-for 的可迭代对象 "${iterableExpression}" 出错:`, error);
                items = [];
            }

            const newNodes = [];
            const fragment = document.createDocumentFragment();

            items.forEach((itemData, index) => {
                let nodeEntry = renderedNodes[index]; // 尝试获取旧条目
                let itemSignal, indexSignal, currentScope;

                if (nodeEntry) {
                    // --- 重用节点 ---
                    itemSignal = nodeEntry.itemSignal;
                    indexSignal = nodeEntry.indexSignal;
                    currentScope = nodeEntry.scope; // 重用 scope 对象

                    // *** 修改: 更新 Signal 的值 ***
                    itemSignal(itemData); // 更新 item Signal
                    if (indexSignal) {
                        indexSignal(index); // 更新 index Signal
                    }
                    // 不需要修改 currentScope 的属性了，因为模板绑定的是 Signal

                } else {
                    // --- 创建新节点 ---
                    const clone = templateElement.cloneNode(true);
                    clone.removeAttribute('n-for');

                    // 创建新的子作用域
                    currentScope = Object.create(scope);
                    // *** 修改: 在子作用域中创建 Signal ***
                    itemSignal = createSignal(itemData);
                    currentScope[itemAlias] = itemSignal; // 将 Signal 放入作用域

                    if (indexAlias) {
                        indexSignal = createSignal(index);
                        currentScope[indexAlias] = indexSignal; // 将 Signal 放入作用域
                    }

                    // 使用子作用域编译克隆出来的节点
                    compileFn(clone, currentScope, directiveHandlers, componentName);

                    // 创建节点条目，存储 Signal
                    nodeEntry = {
                        node: clone,
                        scope: currentScope,
                        itemSignal: itemSignal,
                        indexSignal: indexSignal // 可能为 undefined
                    };
                }

                newNodes.push(nodeEntry); // 添加到新节点列表
                fragment.appendChild(nodeEntry.node); // 添加到文档片段
            });

            // 移除多余的旧节点
            for (let i = renderedNodes.length - 1; i >= items.length; i--) {
                const nodeToRemove = renderedNodes[i].node;
                nodeToRemove.parentNode?.removeChild(nodeToRemove);
                // TODO: 在此清理与移除节点相关的 effect 或 signal？（可选优化）
            }

            // 批量插入新节点
            anchor.parentNode?.insertBefore(fragment, anchor.nextSibling);
            // 更新 renderedNodesMap
            renderedNodes = newNodes;
        });
    }

    /**
     * 处理 n-html 指令。
     * @param {Element} element - 带有 n-html 属性的元素。
     * @param {string} expression - 提供 HTML 内容的表达式。
     * @param {object} scope - 组件作用域。
     * @param {string} componentName - 当前组件名，用于日志。
     */
    function handleNHtml(element, expression, scope, componentName) {
        // n-html 属性已在 compileNode 中移除，这里无需再次移除

        createEffect(() => {
            let htmlContent = '';
            try {
                // 计算表达式的值，期望得到 HTML 字符串
                htmlContent = String(evaluateExpression(expression, scope) ?? ''); // 转为字符串，处理 null/undefined
            } catch (error) {
                console.error(`[${componentName}] 计算 n-html 表达式 "${expression}" 出错:`, error);
                // 在元素内部显示错误信息，避免页面结构破坏
                htmlContent = `<span style="color:red; font-family: monospace;">Error in n-html: ${expression}</span>`;
            }
            // **警告**: 使用 innerHTML 可能导致 XSS 攻击，确保来源可信！
            element.innerHTML = htmlContent;
        });
    }

    /**
     * 处理 n-show 指令。
     * 通过 CSS display 控制显隐，元素始终在 DOM 中。
     * @param {Element} element - 带有 n-show 属性的元素。
     * @param {string} expression - 控制显隐的条件表达式。
     * @param {object} scope - 组件作用域。
     * @param {string} componentName - 当前组件名，用于日志。
     */
    function handleNShow(element, expression, scope, componentName) {
        // 记录元素原始的 display 样式值，以便恢复
        // 注意：如果元素初始 display 为 'none'，这个逻辑也能正确处理
        const originalDisplay = element.style.display === 'none' ? '' : element.style.display;

        createEffect(() => {
            let condition = false;
            try {
                condition = !!evaluateExpression(expression, scope);
            } catch (error) {
                console.error(`[${componentName}] 计算 n-show 表达式 "${expression}" 出错:`, error);
                condition = true; // 出错时默认显示元素，避免隐藏重要内容
            }

            // 根据条件设置 display 样式
            element.style.display = condition ? originalDisplay : 'none';
        });
    }

    /**
     * 处理 n-model 指令，实现双向数据绑定。
     * 支持 input (text, checkbox, radio), textarea, select。
     * @param {Element} element - 表单元素。
     * @param {string} expression - 绑定到作用域中的变量名 (通常是 Signal)。
     * @param {object} scope - 组件作用域。
     * @param {string} componentName - 当前组件名，用于日志。
     */
    function handleNModel(element, expression, scope, componentName) {
        const tagName = element.tagName.toLowerCase();
        const inputType = element.type?.toLowerCase();

        // 尝试获取与表达式关联的 Signal 访问器函数
        const signalAccessor = getSignalAccessor(expression, scope);

        if (!signalAccessor) {
            console.error(`[${componentName}] n-model="${expression}" 无法绑定：表达式未解析为可写的 Signal。`);
            // 添加视觉提示
            element.style.border = '2px solid red';
            element.title = `n-model 绑定错误: ${expression}`;
            return;
        }

        // --- 1. 从 Signal 更新到元素视图 ---
        createEffect(() => {
            const value = signalAccessor(); // 读取 Signal 的当前值
            if (tagName === 'input') {
                if (inputType === 'checkbox') {
                    element.checked = !!value; // 复选框使用 checked 属性
                } else if (inputType === 'radio') {
                    // 单选按钮：当 Signal 的值等于此 radio 的 value 时，选中它
                    element.checked = (value == element.value); // 使用松散比较可能更符合 HTML 表单行为
                } else {
                    // 其他 input 类型 (text, number, date, etc.)
                    if (element.value !== String(value ?? '')) { // 避免不必要的 DOM 更新和光标跳动
                       element.value = String(value ?? ''); // 设置 value 属性
                    }
                }
            } else if (tagName === 'select') {
                // 下拉选择框
                 if (element.value !== String(value ?? '')) {
                    element.value = String(value ?? '');
                 }
                 // 对于 multiple select，需要更复杂的处理来匹配 options
                 // 这里简化为单选 select
            } else if (tagName === 'textarea') {
                // 文本域
                 if (element.value !== String(value ?? '')) {
                    element.value = String(value ?? '');
                 }
            }
        });

        // --- 2. 从元素视图更新到 Signal ---
        // 根据元素类型选择合适的事件
        const eventName = (tagName === 'select' || inputType === 'checkbox' || inputType === 'radio') ? 'change' : 'input';

        element.addEventListener(eventName, (event) => {
            let newValue;
            if (inputType === 'checkbox') {
                newValue = event.target.checked;
            } else if (inputType === 'radio') {
                // 对于 radio，只有选中的那个才需要更新 Signal
                // 如果当前 radio 被选中，则用它的 value 更新 Signal
                if (event.target.checked) {
                    newValue = event.target.value;
                } else {
                    // 如果是取消选中（例如，点击了同组的另一个 radio），则不应由此 radio 更新 Signal
                    return;
                }
            } else {
                newValue = event.target.value;
            }

            try {
                // 调用 Signal 访问器函数来写入新值
                signalAccessor(newValue);
            } catch (error) {
                // 这个 catch 理论上不太可能触发，因为 signalAccessor 内部通常有自己的错误处理
                // 但以防万一
                console.error(`[${componentName}] 更新 n-model Signal "${expression}" 时出错:`, error);
            }
        });
    }

    /**
     * 处理属性绑定 (:attribute)。
     * @param {Element} element - 目标元素。
     * @param {string} attrName - 要绑定的属性名 (不含 ':')。
     * @param {string} expression - 计算属性值的表达式。
     * @param {object} scope - 组件作用域。
     * @param {string} componentName - 当前组件名，用于日志。
     */
    function handleAttributeBinding(element, attrName, expression, scope, componentName) {
        createEffect(() => {
            let value;
            try {
                value = evaluateExpression(expression, scope);
            } catch (error) {
                console.error(`[${componentName}] 计算属性绑定 :${attrName}="${expression}" 出错:`, error);
                // 根据属性类型决定出错时的行为，移除属性通常比较安全
                value = null;
            }

            // 特殊处理 class 和 style
            if (attrName === 'class') {
                // 支持字符串、数组、对象形式的 class 绑定
                let classString = '';
                if (typeof value === 'string') {
                    classString = value;
                } else if (Array.isArray(value)) {
                    classString = value.filter(Boolean).join(' ');
                } else if (typeof value === 'object' && value !== null) {
                    classString = Object.keys(value).filter(key => value[key]).join(' ');
                }
                // TODO: 更智能的 class 更新，避免完全替换？（需要追踪之前添加的 class）
                // 简单起见，直接设置 className
                element.className = classString; // 注意：这会覆盖元素上原有的静态 class，如果需要合并，逻辑会更复杂

            } else if (attrName === 'style') {
                // 支持字符串或对象形式的 style 绑定
                if (typeof value === 'string') {
                    element.style.cssText = value; // 直接设置 style 字符串
                } else if (typeof value === 'object' && value !== null) {
                    // 清除之前的内联样式？或者合并？简单起见，先清除再设置
                    element.style.cssText = ''; // 清除现有内联样式
                    for (const key in value) {
                        if (value.hasOwnProperty(key)) {
                            element.style[key] = value[key]; // 设置对象中的样式
                        }
                    }
                } else {
                    element.style.cssText = ''; // 无效值则清空内联样式
                }

            } else {
                // 处理布尔属性 (e.g., disabled, checked, readonly)
                // HTML 标准规定这些属性存在即为 true
                if (typeof value === 'boolean') {
                    if (value) {
                        element.setAttribute(attrName, ''); // 属性存在即为 true
                    } else {
                        element.removeAttribute(attrName); // 属性不存在即为 false
                    }
                }
                // 处理其他常规属性
                else if (value === null || value === undefined) {
                    element.removeAttribute(attrName); // null 或 undefined 时移除属性
                } else {
                    element.setAttribute(attrName, String(value)); // 其他值转为字符串设置
                }
            }
        });
    }


    // ==================================
    // 暴露指令处理器和核心工具
    // ==================================

    window.NueDirectives = {
        // 核心求值函数，core.js 也可能需要用到 (例如处理文本插值)
        evaluateExpression,

        // 指令处理器
        handleNIf,          // n-if
        handleNFor,         // n-for
        handleNHtml,        // n-html
        handleNShow,        // n-show
        handleNModel,       // n-model
        handleAttributeBinding // :attribute
        // 未来可以添加更多指令处理器...
    };

    console.log("nono-directives.js 加载完成，NueDirectives 对象已准备就绪。");

})(); // 立即执行 IIFE
