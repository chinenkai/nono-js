// nono-directives.js - 处理 n-* 指令及属性绑定

(function() {
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
            const evaluatorFunction = new Function('context', `with(context) { return (${expression}); }`);
            return evaluatorFunction.call(null, context);
        } catch (error) {
            console.error(`指令错误：执行表达式 "${expression}" 时出错:`, error, '\n作用域:', scope, '\n额外上下文:', additionalContext);
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
            if (typeof potentialSignal === 'function' && potentialSignal.length <= 1) {
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
                if (!currentElement) { // 条件为真且元素未显示
                    const clone = element.cloneNode(true);
                    clone.removeAttribute('n-if'); // 移除指令属性，防止无限递归

                    if (!isCompiledOnce) { // 仅在首次创建时编译
                         compileFn(clone, scope, directiveHandlers, componentName);
                         isCompiledOnce = true;
                    }
                    anchor.parentNode?.insertBefore(clone, anchor.nextSibling);
                    currentElement = clone;
                }
            } else {
                if (currentElement) { // 条件为假且元素已显示
                    // NueCore.cleanupAndRemoveNode(currentElement); // 使用核心库的清理函数
                    currentElement.parentNode?.removeChild(currentElement); // 简单移除
                    currentElement = null;
                }
            }
        });
    }

    /**
     * 处理 n-for 指令：根据数组或可迭代对象渲染列表。
     * @param {Element} templateElement - 作为模板的元素。
     * @param {string} expression - n-for 表达式，如 "(item, index) in items"。
     * @param {object} scope - 组件作用域。
     * @param {Function} compileFn - 核心编译函数。
     * @param {object} directiveHandlers - 指令处理器集合。
     * @param {string} componentName - 当前组件名。
     */
    function handleNFor(templateElement, expression, scope, compileFn, directiveHandlers, componentName) {
        const parent = templateElement.parentNode;
        const anchor = document.createComment(` n-for anchor: ${expression} `);
        if (parent) {
            parent.replaceChild(anchor, templateElement);
        } else {
            console.warn(`指令警告：[${componentName}] n-for 元素无父节点，可能无法正确处理。`);
            return;
        }

        const match = expression.match(/^\s*\(?\s*([a-zA-Z0-9_]+)\s*(?:,\s*([a-zA-Z0-9_]+)\s*)?\)?\s+in\s+(.+)$/);
        if (!match) {
            console.error(`指令错误：[${componentName}] 无效的 n-for 表达式: "${expression}"`);
            anchor.textContent = `[n-for 错误: ${expression}]`; // 在锚点处显示错误
            return;
        }

        const itemAlias = match[1];
        const indexAlias = match[2]; // 可能为 undefined
        const iterableExpression = match[3].trim();
        
        let renderedNodeEntries = []; // 存储已渲染的节点及其相关数据 {node, itemSignal, indexSignal, scope}

        createEffect(() => {
            // console.log(`指令信息：[${componentName}] n-for effect for "${iterableExpression}"`);
            let items = [];
            try {
                const iterable = evaluateExpression(iterableExpression, scope);
                items = Array.isArray(iterable) ? iterable : (iterable ? Array.from(iterable) : []);
            } catch (error) {
                // evaluateExpression 内部已打印错误
                items = [];
            }

            const newEntries = [];
            const fragmentToInsert = document.createDocumentFragment();

            items.forEach((itemData, index) => {
                let entry = renderedNodeEntries[index]; // 尝试复用旧条目

                if (entry) { // 复用节点
                    entry.itemSignal(itemData); // 更新 item Signal
                    if (entry.indexSignal) entry.indexSignal(index); // 更新 index Signal
                } else { // 创建新节点
                    const clone = templateElement.cloneNode(true);
                    clone.removeAttribute('n-for');

                    const iterationScope = Object.create(scope); // 创建迭代作用域
                    const itemSignal = createSignal(itemData);
                    iterationScope[itemAlias] = itemSignal;
                    
                    let indexSignal = null;
                    if (indexAlias) {
                        indexSignal = createSignal(index);
                        iterationScope[indexAlias] = indexSignal;
                    }
                    compileFn(clone, iterationScope, directiveHandlers, `${componentName} [n-for item]`);
                    entry = { node: clone, scope: iterationScope, itemSignal, indexSignal };
                }
                newEntries.push(entry);
                fragmentToInsert.appendChild(entry.node);
            });

            // 移除多余的旧节点
            for (let i = items.length; i < renderedNodeEntries.length; i++) {
                const nodeToRemove = renderedNodeEntries[i].node;
                // NueCore.cleanupAndRemoveNode(nodeToRemove); // 使用核心库的清理函数
                nodeToRemove.parentNode?.removeChild(nodeToRemove); // 简单移除
            }
            
            anchor.parentNode?.insertBefore(fragmentToInsert, anchor.nextSibling);
            renderedNodeEntries = newEntries;
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
            let htmlContent = '';
            try {
                htmlContent = String(evaluateExpression(expression, scope) ?? ''); // 处理 null/undefined
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
        const originalDisplay = element.style.display === 'none' ? '' : element.style.display;
        createEffect(() => {
            let condition = true; // 默认显示，以防表达式计算出错
            try {
                condition = !!evaluateExpression(expression, scope);
            } catch (error) {
                // evaluateExpression 内部已打印错误
            }
            element.style.display = condition ? originalDisplay : 'none';
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
            element.style.outline = '2px solid red'; // 视觉提示错误
            return;
        }

        // 1. 从 Signal 更新视图 (Model -> View)
        createEffect(() => {
            const value = signalAccessor();
            if (tagName === 'input') {
                if (inputType === 'checkbox') element.checked = !!value;
                else if (inputType === 'radio') element.checked = (value == element.value); // 松散比较
                else if (element.value !== String(value ?? '')) element.value = String(value ?? '');
            } else if ((tagName === 'select' || tagName === 'textarea') && element.value !== String(value ?? '')) {
                element.value = String(value ?? '');
            }
        });

        // 2. 从视图更新 Signal (View -> Model)
        const eventName = (tagName === 'select' || inputType === 'checkbox' || inputType === 'radio') ? 'change' : 'input';
        element.addEventListener(eventName, (event) => {
            const target = event.target;
            let newValue;
            if (inputType === 'checkbox') newValue = target.checked;
            else if (inputType === 'radio') {
                if (!target.checked) return; // 只处理选中的 radio
                newValue = target.value;
            } else {
                newValue = target.value;
            }
            try {
                signalAccessor(newValue);
            } catch (error) { //理论上不应发生，因为 signalAccessor 是函数
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

            if (attrName === 'class') {
                // 支持字符串、数组、对象形式的 class 绑定
                let classString = '';
                if (typeof value === 'string') classString = value;
                else if (Array.isArray(value)) classString = value.filter(Boolean).join(' ');
                else if (typeof value === 'object' && value !== null) {
                    classString = Object.keys(value).filter(key => value[key]).join(' ');
                }
                // 注意: element.className 会覆盖所有现有 class。
                // 更精细的 class 管理需要追踪由指令添加的 class。
                element.className = classString; 
            } else if (attrName === 'style') {
                // 支持字符串或对象形式的 style 绑定
                if (typeof value === 'string') element.style.cssText = value;
                else if (typeof value === 'object' && value !== null) {
                    element.style.cssText = ''; // 清除旧样式再应用新样式
                    for (const key in value) {
                        if (value.hasOwnProperty(key)) element.style[key] = value[key];
                    }
                } else {
                    element.style.cssText = ''; // 无效值则清空
                }
            } else { // 其他常规属性和布尔属性
                if (typeof value === 'boolean') { // 布尔属性 (disabled, checked, etc.)
                    value ? element.setAttribute(attrName, '') : element.removeAttribute(attrName);
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
        evaluateExpression,     // 核心求值函数，供框架其他部分使用
        handleNIf,
        handleNFor,
        handleNHtml,
        handleNShow,
        handleNModel,
        handleAttributeBinding
    };

    console.log("指令系统：nono-directives.js 加载完成。");
})();
