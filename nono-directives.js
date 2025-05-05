// directives.js - 处理 nue-* 指令 (主要是 if, for, html)

(function() {
    // 确认核心库已加载
    if (!window.NueCore) {
        console.error("核心库 (core.js) 必须先加载！");
        return;
    }
    console.log("directives.js 加载中...");

    // 从核心库获取所需函数
    const { createEffect, compileNode } = window.NueCore; // compileNode 用于递归

    /**
     * **重要:** 安全地执行表达式，现在由 core.js 和 directives.js 共享。
     * @param {string} expression - 要求值的表达式字符串。
     * @param {object} scope - 组件作用域对象 (可能包含原型链)。
     * @param {object} [additionalArgs={}] - 额外的参数对象 { name: value }。
     * @returns {*} 表达式的计算结果。
     * @throws 如果表达式计算出错。
     */
    function evaluateExpression(expression, scope, additionalArgs = {}) {
        // 创建执行上下文，原型为 scope，自有属性为 additionalArgs
        const context = Object.create(scope);
        Object.assign(context, additionalArgs);

        const argNames = ['context'];
        const argValues = [context];

        try {
            // 使用 'with' 确保作用域查找正确
            // 确保表达式被正确地作为返回值处理
            const evaluatorFunction = new Function(...argNames, `with(context) { return (${expression}); }`);
            return evaluatorFunction.apply(null, argValues);
        } catch (error) {
             // 重新抛出错误，让调用者（如 createEffect 或事件处理器）可以捕获并处理
             // console.error(`执行表达式 "${expression}" 时出错:`, error); // 可以在这里加日志
             throw error; // 让上层知道出错了
        }
    }

    /**
     * 处理 if 指令。
     * @param {Element} node - 带有 if 属性的元素。
     * @param {string} expression - if 的表达式。
     * @param {object} scope - 组件作用域。
     * @param {Function} compileFn - 核心编译函数 (compileNode)。
     * @param {object} directiveHandlers - 指令处理器集合。
     * @param {string} componentName - 当前组件名，用于日志
     */
    function handleNueIf(node, expression, scope, compileFn, directiveHandlers, componentName) {
        const parent = node.parentNode;
        const anchor = document.createComment(`if: ${expression}`);
        parent?.replaceChild(anchor, node);

        let currentElement = null;
        let isCompiled = false; // 标记是否已编译过

        createEffect(() => {
            let condition = false;
            try {
                condition = !!evaluateExpression(expression, scope);
            } catch (error) {
                console.error(`[${componentName}] 计算 if 表达式 "${expression}" 出错:`, error);
                condition = false;
            }

            if (condition) {
                if (!currentElement) {
                    // 克隆原始节点（只克隆一次）
                    const clone = node.cloneNode(true);
                    clone.removeAttribute('if'); // 移除指令属性
                    // 编译克隆出来的节点及其子节点 (只编译一次)
                    // 注意：这里传递了 directiveHandlers 和 componentName
                    compileFn(clone, scope, directiveHandlers, componentName);
                    isCompiled = true;
                    // 插入到锚点之后
                    anchor.parentNode?.insertBefore(clone, anchor.nextSibling);
                    currentElement = clone;
                }
            } else {
                if (currentElement) {
                    currentElement.parentNode?.removeChild(currentElement);
                    currentElement = null;
                }
            }
        });
    }

    /**
     * 处理 for 指令。
     * @param {Element} node - 带有 for 属性的元素 (作为模板)。
     * @param {string} expression - for 表达式。
     * @param {object} scope - 组件作用域。
     * @param {Function} compileFn - 核心编译函数 (compileNode)。
     * @param {object} directiveHandlers - 指令处理器集合。
     * @param {string} componentName - 当前组件名，用于日志
     */
    function handleNueFor(node, expression, scope, compileFn, directiveHandlers, componentName) {
        const parent = node.parentNode;
        const anchor = document.createComment(`for: ${expression}`);
        parent?.replaceChild(anchor, node);

        const match = expression.match(/^\s*(\(?\s*([a-zA-Z0-9_]+)\s*(?:,\s*([a-zA-Z0-9_]+)\s*)?\)?)\s+in\s+(.+)$/);
        if (!match) {
            console.error(`[${componentName}] 无效的 for 表达式: "${expression}"`);
            return;
        }
        const alias = match[2];
        const indexAlias = match[3];
        const iterableExpression = match[4].trim();

        let renderedNodesMap = new Map(); // 使用 Map 管理节点，未来可用于 keyed diff

        createEffect(() => {
            let items = [];
            try {
                const result = evaluateExpression(iterableExpression, scope);
                items = Array.isArray(result) ? result : (result ? Array.from(result) : []);
            } catch (error) {
                console.error(`[${componentName}] 计算 for 可迭代对象 "${iterableExpression}" 出错:`, error);
                items = [];
            }

            // --- 简单 diff 和重用策略 ---
            const newRenderedNodesMap = new Map();
            const fragment = document.createDocumentFragment(); // 批量插入优化

            items.forEach((item, index) => {
                // 简单 key：使用 index。更好的 key 应来自数据本身 item.id
                const key = index;
                let existingNodeEntry = renderedNodesMap.get(key);
                let currentNode;

                // 创建子作用域
                const childScope = Object.create(scope);
                childScope[alias] = item;
                if (indexAlias) {
                    childScope[indexAlias] = index;
                }

                if (existingNodeEntry) {
                    // 如果节点已存在，更新其作用域（如果需要，但这里子作用域是临时的）
                    // 对于简单场景，可能不需要特别更新，因为子节点编译时会创建自己的 effect
                    // 如果子节点依赖 item 或 index，它们内部的 effect 会处理更新
                    currentNode = existingNodeEntry.node;
                    // 更新 childScope (重要，否则内部绑定的 item/index 不会更新)
                    // 需要一种方式将新的 childScope 应用到已编译的节点上，这比较复杂
                    // 暂时简化：重新编译可能更简单，或者确保子节点正确响应 scope 变化
                    // **简化处理：暂时不处理作用域更新，依赖子节点内部 effect**
                    renderedNodesMap.delete(key); // 从旧 map 移除，表示已处理
                } else {
                    // 如果节点不存在，创建、编译并添加
                    const clone = node.cloneNode(true);
                    clone.removeAttribute('for');
                    // 使用子作用域编译
                    compileFn(clone, childScope, directiveHandlers, componentName);
                    currentNode = clone;
                }

                fragment.appendChild(currentNode); // 添加到 fragment
                newRenderedNodesMap.set(key, { node: currentNode, scope: childScope }); // 存入新 map
            });

            // 移除旧 map 中剩余的节点 (表示这些数据项已不存在)
            renderedNodesMap.forEach(entry => {
                entry.node.parentNode?.removeChild(entry.node);
            });

            // 批量插入新节点
            anchor.parentNode?.insertBefore(fragment, anchor.nextSibling);
            // 更新 renderedNodesMap
            renderedNodesMap = newRenderedNodesMap;
        });
    }


    /**
     * 处理 html 指令。
     * @param {Element} node - 带有 html 属性的元素。
     * @param {string} expression - html 的表达式。
     * @param {object} scope - 组件作用域。
     */
    function handleNueHtml(node, expression, scope) {
        node.removeAttribute('html'); // 移除属性

        createEffect(() => {
            let htmlContent = '';
            try {
                htmlContent = String(evaluateExpression(expression, scope) || '');
            } catch (error) {
                console.error(`计算 html 表达式 "${expression}" 出错:`, error);
                htmlContent = `<span style="color:red;">Error evaluating html</span>`;
            }
            // 警告：XSS 风险
            node.innerHTML = htmlContent;
        });
    }

    // 将所有指令处理器和核心工具函数挂载到全局 NueDirectives 对象
    window.NueDirectives = {
        handleNueIf,
        handleNueFor,
        handleNueHtml,
        evaluateExpression // **重要:** 暴露 evaluateExpression
        // 未来可以添加更多指令处理器
    };

    console.log("directives.js 加载完成，NueDirectives 对象已准备就绪。");
})();
