// directives.js - 处理 sue-* 指令

(function() {
    // 确认核心库已加载
    if (!window.NueCore) {
        console.error("核心库 (core.js) 必须先加载！");
        return;
    }
    console.log("directives.js 加载中..."); // 保留此日志用于确认加载

    // 从核心库获取所需函数
    const { createEffect, compileNode } = window.NueCore;

    /**
     * 安全地执行表达式，利用 new Function 和内部的 'with' 来处理作用域链。
     * @param {string} expression - 要求值的表达式字符串。
     * @param {object} scope - 组件作用域对象 (可能包含原型链)。
     * @param {object} [additionalArgs={}] - 额外的参数对象 { name: value }，会作为自有属性添加到执行上下文中 (例如 'event', 'item', 'index')。
     * @returns {*} 表达式的计算结果。
     * @throws 如果表达式计算出错，则抛出错误。
     */
    function evaluateExpression(expression, scope, additionalArgs = {}) {
        // 创建一个执行上下文对象，其原型是传入的 scope，保证能访问父作用域变量
        const context = Object.create(scope);
        // 将额外的参数（如 event, item, index）作为自有属性添加到 context
        Object.assign(context, additionalArgs);

        // new Function 的参数列表只包含 context
        const argNames = ['context'];
        const argValues = [context];

        // 函数体使用 'with(context)' 来确保表达式能正确查找变量（先查自有属性，再查原型链）
        // 注意：这里需要返回表达式的值
        const evaluatorFunction = new Function(...argNames, `with(context) { return (${expression}); }`); // 将表达式包裹在括号里可能更安全

        // 调用函数，传入 context 对象
        return evaluatorFunction.apply(null, argValues);
    }

    /**
     * 处理 if 指令。
     * @param {Element} node - 带有 if 属性的元素。
     * @param {string} expression - if 的表达式。
     * @param {object} scope - 组件作用域。
     * @param {Function} compileFn - 核心编译函数 (compileNode)，用于递归编译。
     * @param {object} directiveHandlers - 指令处理器集合。
     */
    function handleNueIf(node, expression, scope, compileFn, directiveHandlers) {
        const parent = node.parentNode;
        // 使用注释节点作为锚点，标记 if 的位置
        const anchor = document.createComment(`if: ${expression}`);
        parent?.replaceChild(anchor, node); // 替换原始节点

        let currentElement = null; // 存储当前条件为真时插入的元素

        createEffect(() => {
            let condition = false;
            try {
                // 使用新的 evaluateExpression 计算条件，并强制转为布尔值
                condition = !!evaluateExpression(expression, scope);
            } catch (error) {
                console.error(`计算 if 表达式 "${expression}" 出错:`, error);
                condition = false; // 出错时视为 false
            }

            if (condition) {
                // 条件为真且当前没有元素
                if (!currentElement) {
                    // 克隆原始节点（包含其内容和属性）
                    const clone = node.cloneNode(true);
                    // 移除 if 属性，防止在编译克隆节点时再次处理
                    clone.removeAttribute('if');
                    // 编译克隆出来的节点及其子节点
                    compileFn(clone, scope, directiveHandlers);
                    // 将编译后的克隆节点插入到锚点之后
                    anchor.parentNode?.insertBefore(clone, anchor.nextSibling);
                    currentElement = clone; // 记录当前显示的元素
                }
            } else {
                // 条件为假且当前有元素显示
                if (currentElement) {
                    // 从 DOM 中移除元素
                    currentElement.parentNode?.removeChild(currentElement);
                    currentElement = null; // 清除记录
                }
            }
        });
    }

    /**
     * 处理 for 指令。
     * @param {Element} node - 带有 for 属性的元素 (作为模板)。
     * @param {string} expression - for 表达式，如 "item in items" 或 "(item, index) in items"。
     * @param {object} scope - 组件作用域。
     * @param {Function} compileFn - 核心编译函数 (compileNode)。
     * @param {object} directiveHandlers - 指令处理器集合。
     */
    function handleNueFor(node, expression, scope, compileFn, directiveHandlers) {
        const parent = node.parentNode;
        // 使用注释节点作为锚点
        const anchor = document.createComment(`for: ${expression}`);
        parent?.replaceChild(anchor, node); // 替换模板节点

        // 解析 for 表达式获取别名和迭代对象表达式
        const match = expression.match(/^\s*(\(?\s*([a-zA-Z0-9_]+)\s*(?:,\s*([a-zA-Z0-9_]+)\s*)?\)?)\s+in\s+(.+)$/);
        if (!match) {
            console.error(`无效的 for 表达式: "${expression}"`);
            return;
        }
        const alias = match[2]; // item 别名
        const indexAlias = match[3]; // index 别名 (可选)
        const iterableExpression = match[4].trim(); // 迭代对象表达式

        let renderedNodes = []; // 存储当前循环渲染出的所有节点

        createEffect(() => {
            let items = [];
            try {
                // 使用 evaluateExpression 获取要迭代的数组
                const result = evaluateExpression(iterableExpression, scope);
                // 确保结果是可迭代的数组
                items = Array.isArray(result) ? result : (result ? Array.from(result) : []);
            } catch (error) {
                console.error(`计算 for 可迭代对象 "${iterableExpression}" 出错:`, error);
                items = [];
            }

            // --- 简化渲染策略：每次更新都清空旧节点 ---
            // (注意：这在实际应用中性能较差，没有进行 diff 和 key 管理)
            renderedNodes.forEach(renderedNode => renderedNode.parentNode?.removeChild(renderedNode));
            renderedNodes = [];
            // --- 结束简化策略 ---

            // 遍历新数据，为每一项创建和编译节点
            items.forEach((item, index) => {
                // 创建子作用域，继承父作用域，并添加 item 和 index 作为自有属性
                const childScope = Object.create(scope);
                childScope[alias] = item;
                if (indexAlias) {
                    childScope[indexAlias] = index;
                }

                // 克隆模板节点
                const clone = node.cloneNode(true);
                // 移除 for 属性，防止无限递归
                clone.removeAttribute('for');

                // 使用子作用域编译克隆的节点
                compileFn(clone, childScope, directiveHandlers);

                // 将编译后的节点插入到锚点之后
                // 使用 anchor.nextSibling 保证插入顺序正确
                anchor.parentNode?.insertBefore(clone, anchor.nextSibling);
                renderedNodes.push(clone); // 记录渲染的节点
            });
        });
    }

    /**
     * 处理 html 指令。
     * @param {Element} node - 带有 html 属性的元素。
     * @param {string} expression - html 的表达式。
     * @param {object} scope - 组件作用域。
     */
    function handleNueHtml(node, expression, scope) {
        // 移除 html 属性，因为它只在编译时需要
        node.removeAttribute('html');

        createEffect(() => {
            let htmlContent = '';
            try {
                // 使用 evaluateExpression 计算 HTML 字符串
                htmlContent = String(evaluateExpression(expression, scope) || '');
            } catch (error) {
                console.error(`计算 html 表达式 "${expression}" 出错:`, error);
                // 在页面上显示错误信息，而不是让页面崩溃
                htmlContent = `<span style="color:red;">Error evaluating html: ${error.message}</span>`;
            }
            // 警告：直接设置 innerHTML 可能有 XSS 风险，确保内容可信！
            node.innerHTML = htmlContent;
        });
    }

    // 将所有指令处理器挂载到全局 NueDirectives 对象上，供 core.js 调用
    window.NueDirectives = {
        handleNueIf,
        handleNueFor,
        handleNueHtml
        // 未来可以添加更多指令处理器
    };

    console.log("directives.js 加载完成，NueDirectives 对象已准备就绪。"); // 保留此日志
})();
