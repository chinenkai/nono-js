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

    // [REPLACE] 步骤 4.1: 用这个实现了智能协调算法的版本替换旧的 handleNFor
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

        let oldNodesMap = new Map(); // key -> { node, scope, item }

        createEffect(() => {
            const newList = this.evaluateExpression(listExpression, scope) || [];
            const parent = placeholder.parentNode;
            if (!parent) return;

            const newNodesMap = new Map();
            const newKeys = new Array(newList.length);
            const oldKeys = Array.from(oldNodesMap.keys());

            // 1. 构建新 key 列表和 newNodesMap 的基础
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

                newKeys[i] = key;
                newNodesMap.set(key, { item, scope: childScope, node: null }); // node 稍后填充
            }

            // 2. 同步、移动和创建节点
            let oldStartIdx = 0,
                newStartIdx = 0;
            let oldEndIdx = oldKeys.length - 1;
            let newEndIdx = newKeys.length - 1;
            let oldStartKey = oldKeys[oldStartIdx];
            let newStartKey = newKeys[newStartIdx];
            let oldEndKey = oldKeys[oldEndIdx];
            let newEndKey = newKeys[newEndIdx];

            let nextNode = placeholder.nextSibling;

            while (oldStartIdx <= oldEndIdx && newStartIdx <= newEndIdx) {
                if (oldStartKey === undefined) {
                    oldStartKey = oldKeys[++oldStartIdx];
                } else if (oldEndKey === undefined) {
                    oldEndKey = oldKeys[--oldEndIdx];
                } else if (oldStartKey === newStartKey) {
                    // 头对头匹配
                    const { node, scope } = oldNodesMap.get(oldStartKey);
                    scope[itemVarName] = newNodesMap.get(newStartKey).item;
                    scope[indexVarName] = newStartIdx;
                    newNodesMap.get(newStartKey).node = node;
                    nextNode = node.nextSibling;
                    oldStartKey = oldKeys[++oldStartIdx];
                    newStartKey = newKeys[++newStartIdx];
                } else if (oldEndKey === newEndKey) {
                    // 尾对尾匹配
                    const { node, scope } = oldNodesMap.get(oldEndKey);
                    scope[itemVarName] = newNodesMap.get(newEndKey).item;
                    scope[indexVarName] = newEndIdx;
                    newNodesMap.get(newEndKey).node = node;
                    oldEndKey = oldKeys[--oldEndIdx];
                    newEndKey = newKeys[--newEndIdx];
                } else if (oldStartKey === newEndKey) {
                    // 头对尾匹配 (移动)
                    const { node, scope } = oldNodesMap.get(oldStartKey);
                    scope[itemVarName] = newNodesMap.get(newEndKey).item;
                    scope[indexVarName] = newEndIdx;
                    newNodesMap.get(newEndKey).node = node;
                    parent.insertBefore(node, oldNodesMap.get(oldEndKey).node.nextSibling);
                    oldStartKey = oldKeys[++oldStartIdx];
                    newEndKey = newKeys[--newEndIdx];
                } else if (oldEndKey === newStartKey) {
                    // 尾对头匹配 (移动)
                    const { node, scope } = oldNodesMap.get(oldEndKey);
                    scope[itemVarName] = newNodesMap.get(newStartKey).item;
                    scope[indexVarName] = newStartIdx;
                    newNodesMap.get(newStartKey).node = node;
                    parent.insertBefore(node, nextNode);
                    nextNode = node;
                    oldEndKey = oldKeys[--oldEndIdx];
                    newStartKey = newKeys[++newStartIdx];
                } else {
                    // 查找新 key 在旧列表中的位置
                    const idxInOld = oldKeys.indexOf(newStartKey);
                    if (idxInOld === -1) {
                        // 新增节点
                        const { scope: childScope } = newNodesMap.get(newStartKey);
                        const clone = element.cloneNode(true);
                        clone.removeAttribute("n-for");
                        if (element.hasAttribute(":key")) clone.removeAttribute(":key");

                        parent.insertBefore(clone, nextNode);
                        nextNode = clone;
                        newNodesMap.get(newStartKey).node = clone;
                        compileFn(clone, childScope, directiveHandlers, `${parentComponentName} (n-for item)`);
                    } else {
                        // 移动节点
                        const keyToMove = oldKeys[idxInOld];
                        const { node, scope } = oldNodesMap.get(keyToMove);
                        scope[itemVarName] = newNodesMap.get(newStartKey).item;
                        scope[indexVarName] = newStartIdx;
                        newNodesMap.get(newStartKey).node = node;
                        parent.insertBefore(node, nextNode);
                        nextNode = node;
                        oldKeys[idxInOld] = undefined; // 标记为已处理
                    }
                    newStartKey = newKeys[++newStartIdx];
                }
            }

            // 3. 处理剩余的节点
            if (oldStartIdx > oldEndIdx) {
                // 如果旧节点已处理完，新增所有剩余的新节点
                const anchor = newEndIdx + 1 < newKeys.length ? newNodesMap.get(newKeys[newEndIdx + 1]).node : placeholder.nextSibling;
                for (let i = newStartIdx; i <= newEndIdx; i++) {
                    const key = newKeys[i];
                    const { scope: childScope } = newNodesMap.get(key);
                    const clone = element.cloneNode(true);
                    clone.removeAttribute("n-for");
                    if (element.hasAttribute(":key")) clone.removeAttribute(":key");

                    parent.insertBefore(clone, anchor);
                    newNodesMap.get(key).node = clone;
                    compileFn(clone, childScope, directiveHandlers, `${parentComponentName} (n-for item)`);
                }
            } else if (newStartIdx > newEndIdx) {
                // 如果新节点已处理完，删除所有剩余的旧节点
                for (let i = oldStartIdx; i <= oldEndIdx; i++) {
                    const key = oldKeys[i];
                    if (key !== undefined) {
                        cleanupAndRemoveNode(oldNodesMap.get(key).node);
                    }
                }
            }

            // 4. 更新 oldNodesMap 以备下次 diff
            oldNodesMap = newNodesMap;
        });
    },

    handleAttributeBinding(element, attrName, expression, scope, parentComponentName) {
        createEffect(() => {
            const value = this.evaluateExpression(expression, scope);
            if (attrName === "class") {
                if (typeof value === "object" && value !== null) {
                    Object.keys(value).forEach((className) => {
                        element.classList.toggle(className, !!value[className]);
                    });
                } else if (typeof value === "string") {
                    element.setAttribute("class", value);
                }
            } else if (attrName === "style") {
                if (typeof value === "object" && value !== null) {
                    Object.assign(element.style, value);
                } else if (typeof value === "string") {
                    element.style.cssText = value;
                }
            } else {
                if (value === false || value === null || value === undefined) {
                    element.removeAttribute(attrName);
                } else {
                    element.setAttribute(attrName, value === true ? "" : String(value));
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
