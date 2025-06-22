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
                compiledFn = new Function("scope", `with(scope) { return (${expression}) }`);

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
                },
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

    // [REPLACE] 最终优化版: 用这个更健壮、更简单的协调算法替换旧的 handleNFor
    handleNFor(element, expression, scope, compileFn, directiveHandlers, parentComponentName) {
        const forRegex = /^\s*\(([^,]+),\s*([^)]+)\)\s+in\s+(.+)$|^\s*([^,]+)\s+in\s+(.+)$/;
        const match = expression.match(forRegex);
        if (!match) {
            console.error(`指令错误：[${parentComponentName}] n-for 表达式格式无效: "${expression}"`);
            return;
        }

        const [_, itemAndIndex, indexName, listExpr1, itemName, listExpr2] = match;
        const isTuple = !!itemAndIndex;
        const itemVarName = isTuple ? itemAndIndex.trim() : itemName.trim();
        const indexVarName = isTuple ? indexName.trim() : "index";
        const listExpression = isTuple ? listExpr1.trim() : listExpr2.trim();

        const placeholder = document.createComment(`n-for: ${expression}`);
        element.parentNode.insertBefore(placeholder, element);
        element.parentNode.removeChild(element);

        let oldNodesMap = new Map(); // key -> { node, scope }

        createEffect(() => {
            const newList = this.evaluateExpression(listExpression, scope) || [];
            const parent = placeholder.parentNode;
            if (!parent) return;

            const newNodesMap = new Map();
            const newKeys = new Set();

            // `lastNode` 是一个游标，始终指向前一个被正确放置的节点。
            // 新节点或被移动的节点总是被插入到它的后面。
            let lastNode = placeholder;

            // =================================================================
            // Pass 1: 遍历新列表，进行创建、更新和移动
            // =================================================================
            for (let i = 0; i < newList.length; i++) {
                const item = newList[i];
                const childScope = Object.create(scope);
                childScope[itemVarName] = item;
                childScope[indexVarName] = i;

                const keyAttr = element.getAttribute(":key");
                const key = keyAttr ? this.evaluateExpression(keyAttr, childScope) : i;

                if (key === null || key === undefined) {
                    console.warn(`指令警告：[${parentComponentName}] n-for 中的 key 为 null 或 undefined。这可能导致渲染行为异常。`);
                }
                newKeys.add(key);

                const oldEntry = oldNodesMap.get(key);

                if (oldEntry) {
                    // --- 情况 A: 节点已存在，需要更新和移动 ---
                    const { node, scope: oldScope } = oldEntry;

                    // 1. 更新数据 (scope)
                    oldScope[itemVarName] = item;
                    oldScope[indexVarName] = i;

                    // 2. 移动到正确位置
                    // 如果当前节点不是紧跟在前一个已放置节点的后面，说明它的位置错了，需要移动。
                    if (node.previousSibling !== lastNode) {
                        parent.insertBefore(node, lastNode.nextSibling);
                    }

                    // 3. 更新游标
                    lastNode = node;
                    newNodesMap.set(key, oldEntry);
                } else {
                    // --- 情况 B: 节点是全新的，需要创建 ---
                    const clone = element.cloneNode(true);
                    clone.removeAttribute("n-for");
                    if (keyAttr) clone.removeAttribute(":key");

                    // 1. 插入到正确位置
                    parent.insertBefore(clone, lastNode.nextSibling);

                    // 2. 更新游标
                    lastNode = clone;

                    // 3. 编译新节点并存入 newNodesMap
                    const newEntry = { node: clone, scope: childScope };
                    newNodesMap.set(key, newEntry);
                    compileFn(clone, childScope, directiveHandlers, `${parentComponentName} (n-for item)`);
                }
            }

            // =================================================================
            // Pass 2: 移除不再需要的旧节点
            // =================================================================
            for (const [key, { node }] of oldNodesMap.entries()) {
                if (!newKeys.has(key)) {
                    cleanupAndRemoveNode(node);
                }
            }

            // 为下一次更新做准备
            oldNodesMap = newNodesMap;
        });
    },

    handleAttributeBinding(element, attrName, expression, scope, parentComponentName) {
        // 将 kebab-case 的 attrName 转换为 camelCase 的 propName
        const propName = attrName.replace(/-(\w)/g, (_, letter) => letter.toUpperCase());

        createEffect(() => {
            const value = this.evaluateExpression(expression, scope);

            // 准确判断是否为 Web Component
            const isWebComponent = element.tagName.includes("-") && window.customElements.get(element.tagName.toLowerCase());

            if (attrName === "class") {
                // class 的处理逻辑保持不变
                if (typeof value === "object" && value !== null) {
                    Object.keys(value).forEach((className) => {
                        element.classList.toggle(className, !!value[className]);
                    });
                } else if (typeof value === "string") {
                    element.setAttribute("class", value);
                }
            } else if (attrName === "style") {
                // style 的处理逻辑保持不变
                if (typeof value === "object" && value !== null) {
                    Object.assign(element.style, value);
                } else if (typeof value === "string") {
                    element.style.cssText = value;
                }
            } else if (isWebComponent && propName in element) {
                // **策略核心：如果目标是 Web Component 且存在对应的 JS Property，则直接设置 Property**
                // 这可以传递任何类型的数据（对象、数组、布尔值），无需序列化，性能最高。
                try {
                    element[propName] = value;
                } catch (e) {
                    console.error(`核心错误：为 Web Component <${element.tagName.toLowerCase()}> 设置属性 "${propName}" 时出错。`, e);
                }
            } else {
                // **回退策略：对于普通 HTML 元素，或 Web Component 上不存在对应 Property 的情况**
                if (value === false || value === null || value === undefined) {
                    element.removeAttribute(attrName);
                } else {
                    // 这里的序列化逻辑现在只作为一种兼容性回退，而不是首选
                    const finalValue = typeof value === "object" ? JSON.stringify(value) : value === true ? "" : String(value);
                    element.setAttribute(attrName, finalValue);
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
            if (target.type === "checkbox") {
                value = target.checked;
            } else if (target.type === "radio") {
                if (target.checked) value = target.value;
                else return; // 如果 radio 未选中，不更新 signal
            } else {
                value = target.value;
            }
            signal(value);
        };

        element.addEventListener("input", updateSignal);
        element.addEventListener("change", updateSignal);

        createEffect(() => {
            const value = signal();
            if (element.type === "checkbox") {
                element.checked = !!value;
            } else if (element.type === "radio") {
                element.checked = element.value === String(value);
            } else {
                if (element.value !== value) {
                    element.value = value === null || value === undefined ? "" : value;
                }
            }
        });
    },

    handleNShow(element, expression, scope, parentComponentName) {
        createEffect(() => {
            const condition = !!this.evaluateExpression(expression, scope);
            element.style.display = condition ? "" : "none";
        });
    },

    handleNHtml(element, expression, scope, parentComponentName) {
        createEffect(() => {
            element.innerHTML = this.evaluateExpression(expression, scope) || "";
        });
    },
};
