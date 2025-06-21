// ===================================================================
// 指令系统 (NueDirectives)
// ===================================================================

// 添加一个缓存来存储已编译的表达式函数
const expressionCache = new Map();

window.NueDirectives = {


    /**
     * 【已重构 & 优化】核心表达式求值函数，带编译缓存。
     * @param {string} expression - 要执行的 JS 表达式字符串。
     * @param {object} scope - 表达式执行的作用域。
     * @param {boolean} [autoUnwrap=true] - 是否自动解包 Signal。
     * @returns {*} 表达式的执行结果。
     */
    evaluateExpression(expression, scope, autoUnwrap = true) {
        if (!expression) return undefined;

        // 关键优化：检查缓存中是否已有编译好的函数
        let compiledFn = expressionCache.get(expression);

        if (!compiledFn) {
            // 如果缓存中没有，则只编译一次
            try {
                // 我们仍然使用 `with`，因为它是在没有AST解析器的情况下，
                // 实现模板中简洁语法 (如 `count` 而非 `scope.count`) 的唯一方式。
                // 但现在，这个昂贵的 `new Function` 操作对于每个表达式字符串来说，
                // 在整个应用的生命周期中只会执行一次！
                compiledFn = new Function('scope', `with(scope) { return (${expression}) }`);
                
                // 将编译好的函数存入缓存
                expressionCache.set(expression, compiledFn);
            } catch (error) {
                console.error(`核心错误：编译表达式 "${expression}" 时出错:`, error);
                // 缓存一个错误函数，避免重复编译失败的表达式
                const errorFn = () => {
                    console.error(`尝试执行一个编译失败的表达式: "${expression}"`);
                    return undefined;
                };
                expressionCache.set(expression, errorFn);
                return errorFn();
            }
        }

        // 准备执行上下文
        let context = scope;
        if (autoUnwrap) {
            // Proxy 仍然是实现 Signal 自动解包的最优方式
            context = new Proxy(scope, {
                get(target, prop, receiver) {
                    if (Reflect.has(target, prop)) {
                        const value = Reflect.get(target, prop, receiver);
                        if (value && value.__is_signal__ === true) {
                            return value();
                        }
                        return value;
                    }
                    return undefined;
                },
                has(target, prop) {
                    return Reflect.has(target, prop);
                }
            });
        }

        // 执行（已缓存的）编译后函数
        try {
            return compiledFn(context);
        } catch (error) {
            // 这里的错误是运行时错误，而不是编译错误
            console.error(`核心错误：执行表达式 "${expression}" 时出错:`, error);
            return undefined;
        }
    },


    handleNIf(element, expression, scope, compileFn, directiveHandlers, parentComponentName) {
        const placeholder = document.createComment(`n-if: ${expression}`);
        let isShowing = false;
        let currentElement = null;
        
        element.parentNode.insertBefore(placeholder, element);
        element.parentNode.removeChild(element);

        createEffect(() => {
            const condition = !!this.evaluateExpression(expression, scope);
            if (condition && !isShowing) {
                isShowing = true;
                const clone = element.cloneNode(true);
                clone.removeAttribute("n-if");
                currentElement = clone;
                placeholder.parentNode.insertBefore(clone, placeholder.nextSibling);
                compileFn(clone, scope, directiveHandlers, `${parentComponentName} (n-if)`);
            } else if (!condition && isShowing) {
                isShowing = false;
                if (currentElement) {
                    cleanupAndRemoveNode(currentElement);
                    currentElement = null;
                }
            }
        });
    },

    handleNFor(element, expression, scope, compileFn, directiveHandlers, parentComponentName) {
        const forRegex = /^\s*\(([^,]+),\s*([^)]+)\)\s+in\s+(.+)$|^\s*([^,]+)\s+in\s+(.+)$/;
        const match = expression.match(forRegex);
        if (!match) { console.error(`指令错误：[${parentComponentName}] n-for 表达式格式无效: "${expression}"`); return; }

        const [_, itemAndIndex, indexName, listExpr1, itemName, listExpr2] = match;
        const isTuple = !!itemAndIndex;
        const itemVarName = isTuple ? itemAndIndex.trim() : itemName.trim();
        const indexVarName = isTuple ? indexName.trim() : 'index';
        const listExpression = isTuple ? listExpr1.trim() : listExpr2.trim();

        const placeholder = document.createComment(`n-for: ${expression}`);
        element.parentNode.insertBefore(placeholder, element);
        element.parentNode.removeChild(element);

        let renderedElements = new Map();

        createEffect(() => {
            const list = this.evaluateExpression(listExpression, scope) || [];
            const newRenderedElements = new Map();
            const parent = placeholder.parentNode;
            let lastNode = placeholder;

            list.forEach((item, index) => {
                const keyAttr = element.getAttribute(':key');
                const key = keyAttr ? this.evaluateExpression(keyAttr, { ...scope, [itemVarName]: item, [indexVarName]: index }) : index;

                if (renderedElements.has(key)) {
                    const { node, scope: childScope } = renderedElements.get(key);
                    childScope[itemVarName] = item;
                    childScope[indexVarName] = index;
                    parent.insertBefore(node, lastNode.nextSibling);
                    lastNode = node;
                    newRenderedElements.set(key, { node, scope: childScope });
                    renderedElements.delete(key);
                } else {
                    const childScope = Object.create(scope);
                    childScope[itemVarName] = item;
                    childScope[indexVarName] = index;
                    const clone = element.cloneNode(true);
                    clone.removeAttribute('n-for');
                    if (keyAttr) clone.removeAttribute(':key');
                    parent.insertBefore(clone, lastNode.nextSibling);
                    lastNode = clone;
                    newRenderedElements.set(key, { node: clone, scope: childScope });
                    compileFn(clone, childScope, directiveHandlers, `${parentComponentName} (n-for item)`);
                }
            });

            renderedElements.forEach(({ node }) => cleanupAndRemoveNode(node));
            renderedElements = newRenderedElements;
        });
    },

    handleAttributeBinding(element, attrName, expression, scope, parentComponentName) {
        createEffect(() => {
            const value = this.evaluateExpression(expression, scope);
            if (attrName === 'class') {
                if (typeof value === 'object' && value !== null) {
                    Object.keys(value).forEach(className => {
                        element.classList.toggle(className, !!value[className]);
                    });
                } else if (typeof value === 'string') {
                    element.setAttribute('class', value);
                }
            } else if (attrName === 'style') {
                if (typeof value === 'object' && value !== null) {
                    Object.assign(element.style, value);
                } else if (typeof value === 'string') {
                    element.style.cssText = value;
                }
            } else {
                if (value === false || value === null || value === undefined) {
                    element.removeAttribute(attrName);
                } else {
                    element.setAttribute(attrName, value === true ? '' : String(value));
                }
            }
        });
    },

    handleNModel(element, expression, scope, parentComponentName) {
        const signal = this.evaluateExpression(expression, scope, false); // 获取 Signal 引用
        if (!signal || !signal.__is_signal__) {
            console.error(`指令错误：[${parentComponentName}] n-model 必须绑定到一个 Signal。"${expression}" 不是一个有效的 Signal。`);
            return;
        }

        const updateSignal = (event) => {
            const target = event.target;
            let value;
            if (target.type === 'checkbox') {
                value = target.checked;
            } else if (target.type === 'radio') {
                if (target.checked) value = target.value;
                else return; // 如果 radio 未选中，不更新 signal
            } else {
                value = target.value;
            }
            signal(value);
        };

        element.addEventListener('input', updateSignal);
        element.addEventListener('change', updateSignal);

        createEffect(() => {
            const value = signal();
            if (element.type === 'checkbox') {
                element.checked = !!value;
            } else if (element.type === 'radio') {
                element.checked = (element.value === String(value));
            } else {
                if (element.value !== value) {
                    element.value = value === null || value === undefined ? '' : value;
                }
            }
        });
    },

    handleNShow(element, expression, scope, parentComponentName) {
        createEffect(() => {
            const condition = !!this.evaluateExpression(expression, scope);
            element.style.display = condition ? '' : 'none';
        });
    },

    handleNHtml(element, expression, scope, parentComponentName) {
        createEffect(() => {
            element.innerHTML = this.evaluateExpression(expression, scope) || '';
        });
    },
};
