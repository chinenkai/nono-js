// ==================================
// 1. Signal 核心实现 (保持不变)
// ==================================
let currentEffect = null;

function createSignal(initialValue) {
    // ... (代码和之前一样) ...
    let value = initialValue;
    const subscribers = new Set();

    function signalAccessor(newValue) {
        if (arguments.length === 0) { // 读取
            if (currentEffect) {
                subscribers.add(currentEffect);
            }
            return value;
        } else { // 写入
            if (value !== newValue) {
                value = newValue;
                [...subscribers].forEach(effect => effect());
            }
            return newValue;
        }
    }
    return signalAccessor;
}

function createEffect(fn) {
    // ... (代码和之前一样) ...
    const effect = () => {
        currentEffect = effect;
        try { fn(); } finally { currentEffect = null; }
    };
    effect();
}

// ==================================
// 2. 组件缓存
// ==================================
const componentCache = new Map(); // 缓存已加载和解析的组件数据

// ==================================
// 3. 组件处理
// ==================================

/**
 * 解析 .nue 文件内容，提取 template, script, style
 * @param {string} text .nue 文件文本内容
 * @returns {{template: string, script: string, style: string}}
 */
function parseComponentStructure(text) {
    // 简单优化：如果缓存中有，直接返回
    if (componentCache.has(text)) {
        const cached = componentCache.get(text);
        if (cached.structure) return cached.structure;
    }

    console.log("解析组件结构...");
    const template = text.match(/<template>([\s\S]*?)<\/template>/)?.[1] || '';
    const script = text.match(/<script>([\s\S]*?)<\/script>/)?.[1] || '';
    const style = text.match(/<style>([\s\S]*?)<\/style>/)?.[1] || '';
    const structure = { template, script, style };

    // 存入缓存 (仅结构)
    let cacheEntry = componentCache.get(text) || {};
    cacheEntry.structure = structure;
    componentCache.set(text, cacheEntry);

    return structure;
}

/**
 * 使用 Acorn 解析脚本内容为 AST (抽象语法树)
 * @param {string} scriptContent 脚本字符串
 * @returns {object | null} Acorn AST 对象，如果解析失败则返回 null
 */
function parseScriptWithAcorn(scriptContent) {
    if (!window.acorn) {
        console.error("Acorn 解析器未加载！请在 HTML 中引入 acorn.js。");
        return null;
    }
    console.log("使用 Acorn 解析脚本...");
    try {
        // 使用 Acorn 解析。
        // *** 修改点：添加 allowReturnOutsideFunction: true 选项 ***
        const ast = acorn.parse(scriptContent, {
            ecmaVersion: 2020,
            sourceType: "module", // 或者 "script"，取决于你的代码是否包含 import/export
            allowReturnOutsideFunction: true // <--- 允许顶层 return
        });
        console.log("Acorn 解析成功.");
        // console.log("AST:", ast);
        return ast;
    } catch (error) {
        console.error("Acorn 解析脚本失败:", error); // <--- 错误在这里被捕获和报告
        console.error("问题脚本:\n", scriptContent);
        return null;
    }
}


/**
 * @param {string} scriptContent 脚本字符串
 * @param {object} ast Acorn 解析出的 AST (可选)
 * @param {object} [initialProps={}] 父组件传递的 Props 对象 (键是 prop 名称，值是 Signal 或静态值)
 * @param {Function} [emit=()=>{}] 子组件用于触发事件的函数
 * @returns {object} 组件的作用域对象 (由脚本显式 return 返回)
 */
function executeScript(scriptContent, ast, initialProps = {}, emit = () => console.warn("emit function not provided")) {
    if (ast === null) {
        console.warn("由于脚本解析失败，跳过执行。");
        return {};
    }

    console.log("准备执行脚本 (注入 props 和 emit)...");
    try {
        // 创建一个函数，其主体是用户脚本。
        // 注入 createSignal, props, emit
        const scriptFunction = new Function('createSignal', 'props', 'emit', `
            // 脚本在此处执行
            ${scriptContent}
            // 脚本作者需要确保最后有 return 语句，例如：
            // return { internalState, someMethod };
        `);

        // 执行脚本并传入依赖项
        const componentScope = scriptFunction(createSignal, initialProps, emit);

        if (typeof componentScope === 'object' && componentScope !== null) {
            console.log("脚本执行完毕，返回作用域:", componentScope);
            return componentScope;
        } else {
            console.warn("脚本执行了，但没有返回一个对象作为作用域。请确保脚本最后有 'return { ... };' 语句。将返回空作用域。");
            if (typeof componentScope === 'undefined') {
                console.warn("提示：脚本似乎缺少最后的 'return { ... };' 语句。");
            }
            return {};
        }
    } catch (error) {
        console.error("执行组件脚本时出错:", error);
        console.error("脚本内容:\n", scriptContent);
        return {};
    }
}

/**
 * @param {object} eventHandlers - 父组件提供的事件处理器映射 { eventName: handlerFunc }
 * @param {string} componentName - 用于日志记录的组件名
 * @returns {Function} emit 函数 (eventName, payload) => void
 */
function createEmitFunction(eventHandlers, componentName = 'ChildComponent') {
    return function emit(eventName, payload) {
        console.log(`${componentName} 发出事件: ${eventName}`, payload);
        const handler = eventHandlers[eventName];
        if (handler && typeof handler === 'function') {
            try {
                handler(payload); // 直接调用父组件创建的处理函数
            } catch (error) {
                console.error(`执行 ${componentName} 的事件 "${eventName}" 处理器时出错:`, error);
            }
        } else {
            console.warn(`${componentName} 尝试发出未被监听的事件: ${eventName}`);
        }
    };
}


/**
 * @param {Node} node 当前处理的 DOM 节点
 * @param {object} scope 组件的作用域对象
 * @param {object} directiveHandlers 包含指令处理函数的对象
 * @param {string} [parentComponentName='Root'] 父组件名称，用于日志
 */
function compileNode(node, scope, directiveHandlers, parentComponentName = 'Root') {
    if (node.nodeType === Node.ELEMENT_NODE) {
        const tagName = node.tagName.toLowerCase();

        // **新增:** 检查是否是潜在的子组件标签 (简单约定：包含连字符)
        // 更健壮的方式是维护一个组件注册表
        if (tagName.includes('-') && !['template', 'script', 'style'].includes(tagName)) {
            console.log(`[${parentComponentName}] 发现潜在子组件标签: <${tagName}>`);
            // 假设标签名对应组件文件名，例如 'child-component' -> 'child-component.nue'
            const componentUrl = `${tagName}.nue`;

            // **新增:** 解析 Props 和事件监听器
            const initialProps = {};
            const eventHandlers = {};
            const attributesToRemove = []; // 记录需要移除的属性

            for (const attr of Array.from(node.attributes)) {
                const attrName = attr.name;
                const attrValue = attr.value;

                if (attrName.startsWith(':')) { // 动态 Prop (绑定)
                    const propName = attrName.substring(1);
                    const expression = attrValue;
                    console.log(`[${parentComponentName}] 解析动态 Prop :${propName}="${expression}"`);
                    // 创建一个 Signal 来包装父组件的表达式，确保子组件能响应式地接收更新
                    const propSignal = createSignal(undefined); // 初始值设为 undefined
                    // 在父组件作用域内创建一个 effect 来更新这个 propSignal
                    createEffect(() => {
                        try {
                            // 使用父组件的 scope 来计算表达式
                            const value = directiveHandlers.evaluateExpression(expression, scope);
                            // console.log(`[${parentComponentName}] 更新 Prop :${propName} 的值 ->`, value);
                            propSignal(value); // 更新 Signal
                        } catch (error) {
                            console.error(`[${parentComponentName}] 计算 Prop "${propName}" 表达式 "${expression}" 出错:`, error);
                            propSignal(undefined); // 出错时设为 undefined
                        }
                    });
                    initialProps[propName] = propSignal; // 将 Signal 传递给子组件
                    attributesToRemove.push(attrName);

                } else if (attrName.startsWith('@')) { // 事件监听器
                    const eventName = attrName.substring(1);
                    const handlerExpression = attrValue;
                    console.log(`[${parentComponentName}] 解析事件监听 @${eventName}="${handlerExpression}"`);
                    // 创建一个在父组件作用域内执行的处理函数
                    eventHandlers[eventName] = (payload) => {
                        console.log(`[${parentComponentName}] 接收到子组件事件 "${eventName}"，执行: ${handlerExpression}`, payload);
                        try {
                            // 将 payload 注入到执行上下文中，通常命名为 'event' 或 '$event'
                            const context = Object.create(scope);
                            context.$event = payload; // 使用 $event 作为载荷变量名
                            const argNames = ['context'];
                            const argValues = [context];
                            // 注意：事件处理器通常不需要 return
                            const handlerFunction = new Function(...argNames, `with(context) { ${handlerExpression} }`);
                            handlerFunction.apply(null, argValues);
                        } catch (error) {
                            console.error(`[${parentComponentName}] 执行事件处理器 "${handlerExpression}" 出错:`, error);
                        }
                    };
                    attributesToRemove.push(attrName);

                } else { // 静态 Prop
                    console.log(`[${parentComponentName}] 解析静态 Prop ${attrName}="${attrValue}"`);
                    // 静态 prop 直接传递值，不需要 signal
                    initialProps[attrName] = attrValue;
                    // 静态属性通常也应该移除，避免传递给最终的 HTML 元素
                    attributesToRemove.push(attrName);
                }
            }

            // 移除已处理的特殊属性
            attributesToRemove.forEach(attrName => node.removeAttribute(attrName));

            // **新增:** 异步挂载子组件
            // 创建一个占位符节点，子组件挂载后会替换它
            const placeholder = document.createComment(`component: ${tagName}`);
            node.parentNode?.replaceChild(placeholder, node);

            // 调用 mountComponent (或一个包装器) 来加载和挂载子组件
            // 注意：mountComponent 现在需要返回挂载的 DOM 节点
            mountComponent(componentUrl, placeholder, initialProps, eventHandlers, tagName /*传递组件名用于日志*/)
                .then(mountedNode => {
                    if (mountedNode && placeholder.parentNode) {
                        // 用实际挂载的子组件根节点替换占位符
                        placeholder.parentNode.replaceChild(mountedNode, placeholder);
                        console.log(`[${parentComponentName}] 子组件 <${tagName}> 挂载完成.`);
                    } else {
                         console.error(`[${parentComponentName}] 子组件 <${tagName}> 挂载失败或占位符已移除.`);
                         // 可以在占位符处插入错误信息
                         const errorNode = document.createElement('div');
                         errorNode.style.color = 'red';
                         errorNode.textContent = `Error mounting <${tagName}>`;
                         placeholder.parentNode?.insertBefore(errorNode, placeholder.nextSibling);
                    }
                })
                .catch(error => {
                    console.error(`[${parentComponentName}] 挂载子组件 <${tagName}> (${componentUrl}) 失败:`, error);
                     // 可以在占位符处插入错误信息
                     const errorNode = document.createElement('div');
                     errorNode.style.color = 'red';
                     errorNode.textContent = `Error loading/mounting <${tagName}>: ${error.message}`;
                     placeholder.parentNode?.insertBefore(errorNode, placeholder.nextSibling);
                });

            // 子组件已交由 mountComponent 处理，不再递归编译此节点
            return;
        }

        // --- 处理非组件元素 (原有逻辑) ---

        // 优先处理结构性指令 if, for
        const ifAttr = node.getAttribute('if');
        const forAttr = node.getAttribute('for');

        if (ifAttr !== null) {
            // 传递 parentComponentName
            directiveHandlers.handleNueIf(node, ifAttr, scope, compileNode, directiveHandlers, parentComponentName);
            return;
        }
        if (forAttr !== null) {
             // 传递 parentComponentName
            directiveHandlers.handleNueFor(node, forAttr, scope, compileNode, directiveHandlers, parentComponentName);
            return;
        }

        // 处理其他属性指令，如 html
        const htmlAttr = node.getAttribute('html');
        if (htmlAttr !== null) {
            directiveHandlers.handleNueHtml(node, htmlAttr, scope);
        }

        // 处理事件绑定 @event (原生 HTML 元素事件 或 组件内部元素事件)
        const attrs = Array.from(node.attributes);
        attrs.forEach(attr => {
            if (attr.name.startsWith('@')) {
                const eventName = attr.name.substring(1);
                let handlerExpression = attr.value; // 例如 "incrementInternal" 或 "someMethod(arg)"

                // **修正点:** 检查表达式是否看起来像一个简单的函数名，如果是，则添加 ()
                // 这是一个启发式方法，可能不完美，但能处理最常见情况
                // 更健壮的方法需要更复杂的表达式解析
                let executionCode = handlerExpression;
                // 如果表达式是一个简单的标识符（可能带点号），并且不包含括号，则假定是方法调用
                if (/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(handlerExpression.trim())) {
                     executionCode = `${handlerExpression.trim()}()`; // 附加括号
                     console.log(`[${parentComponentName}] 简单方法名检测，将执行: ${executionCode}`);
                } else if (!handlerExpression.includes('(') && handlerExpression.includes('=')) {
                    // 处理类似 @click="count = count + 1" 的情况，不需要加括号
                    executionCode = handlerExpression;
                } else if (!handlerExpression.includes('(')) {
                    // 其他不含括号的简单表达式，可能也需要调用？或者就是属性访问？
                    // 暂时保守处理，认为简单标识符才需要自动加括号
                    // 如果需要更灵活，模板里就必须写完整的调用，如 @click="myVar = true" 或 @click="doCalc()"
                     console.warn(`[${parentComponentName}] 事件处理器 "${handlerExpression}" 不含括号，将按原样执行。如果它是方法，请在模板中添加 ()`);
                }


                node.addEventListener(eventName, (event) => {
                    console.log(`[${parentComponentName}] 触发事件 ${eventName}，执行代码: ${executionCode}`);
                    try {
                        const context = Object.create(scope);
                        context.event = event; // 将原生 event 对象放入上下文

                        // 使用修正后的 executionCode
                        const handlerExecutor = new Function('context', `with(context) { ${executionCode} }`);
                        handlerExecutor.call(null, context);

                    } catch (error) {
                        console.error(`[${parentComponentName}] 执行事件处理器代码 "${executionCode}" (源: "${handlerExpression}") 出错:`, error);
                    }
                });
            }
        });

        // 递归处理子节点
        Array.from(node.childNodes).forEach(child => compileNode(child, scope, directiveHandlers, parentComponentName)); // 传递 parentComponentName

    } else if (node.nodeType === Node.TEXT_NODE) {
        // 处理文本插值 {{ expression }} (保持不变)
        const text = node.textContent || '';
        const regex = /\{\{([^}]+)\}\}/g;
        if (!regex.test(text)) return;

        const segments = [];
        let match;
        let lastIndex = 0;
        regex.lastIndex = 0;

        while ((match = regex.exec(text)) !== null) {
            if (match.index > lastIndex) {
                segments.push(document.createTextNode(text.substring(lastIndex, match.index)));
            }
            const expression = match[1].trim();
            const placeholderNode = document.createTextNode(''); // 初始为空
            segments.push(placeholderNode);

            createEffect(() => {
                try {
                    // 使用 directiveHandlers.evaluateExpression 统一处理表达式求值
                    const value = directiveHandlers.evaluateExpression(expression, scope);
                    placeholderNode.textContent = value === undefined || value === null ? '' : String(value);
                } catch (error) {
                    console.error(`[${parentComponentName}] 计算表达式 "{{${expression}}}" 出错:`, error);
                    placeholderNode.textContent = `{{Error}}`; // 简化错误显示
                }
            });
            lastIndex = regex.lastIndex;
        }
        if (lastIndex < text.length) {
            segments.push(document.createTextNode(text.substring(lastIndex)));
        }

        if (segments.length > 0 && node.parentNode) {
            segments.forEach(segment => node.parentNode.insertBefore(segment, node));
            node.parentNode.removeChild(node);
        }
    }
}

/**
 * 将 CSS 样式注入到文档头部
 * @param {string} css CSS 字符串
 * @param {string} componentUrl 用于生成唯一 ID，防止重复注入
 */
function injectStyles(css, componentUrl) {
    if (!css || !css.trim()) return;
    const styleId = `nue-style-${componentUrl.replace(/[^a-zA-Z0-9]/g, '-')}`; // 基于 URL 生成 ID
    if (document.getElementById(styleId)) {
        console.log(`样式 ${styleId} 已存在，跳过注入。`);
        return; // 防止重复注入
    }
    console.log(`注入样式 ${styleId}...`);
    const styleElement = document.createElement('style');
    styleElement.id = styleId;
    styleElement.textContent = css;
    document.head.appendChild(styleElement);
    console.log("样式注入完成.");
}

/**
 * @param {string} componentUrl .nue 文件的 URL
 * @param {string | Element | Comment} target - CSS 选择器、目标元素或占位符注释节点
 * @param {object} [initialProps={}] - 传递给组件的 Props
 * @param {object} [eventHandlers={}] - 父组件提供的事件处理器
 * @param {string} [componentName='Component'] - 组件名称，用于日志
 * @returns {Promise<Element | null>} 返回挂载的组件根元素 (第一个 Element 节点)，如果失败则返回 null
 */
async function mountComponent(componentUrl, target, initialProps = {}, eventHandlers = {}, componentName = 'Component') {
    console.log(`[Core] 开始挂载组件: ${componentName} (${componentUrl})`);
    let targetElement = null; // 挂载的目标 DOM 节点
    let isPlaceholder = false; // 标记 target 是否是占位符

    if (typeof target === 'string') {
        targetElement = document.querySelector(target);
        if (!targetElement) {
            console.error(`[Core] 挂载失败：找不到目标元素 "${target}"`);
            return null;
        }
    } else if (target instanceof Element) {
        targetElement = target;
    } else if (target instanceof Comment) { // 支持挂载到注释占位符
        targetElement = target;
        isPlaceholder = true;
    } else {
         console.error(`[Core] 挂载失败：无效的目标`, target);
         return null;
    }

    // 检查指令处理器
    if (typeof window.NueDirectives === 'undefined' || typeof window.NueDirectives.evaluateExpression !== 'function') {
         console.error("[Core] 指令处理器 (directives.js) 或其 evaluateExpression 未加载！");
         if (targetElement && !isPlaceholder) targetElement.innerHTML = `<p style="color: red;">错误：directives.js 未加载</p>`;
         return null;
    }
     // 检查 Acorn
    if (typeof window.acorn === 'undefined') {
        console.error("[Core] Acorn 解析器 (acorn.js) 未加载！");
        if (targetElement && !isPlaceholder) targetElement.innerHTML = `<p style="color: red;">错误：acorn.js 未加载</p>`;
        return null;
    }


    try {
        // 1. 加载组件文件 (使用缓存)
        let componentText;
        let cacheEntry = componentCache.get(componentUrl);
        if (cacheEntry && cacheEntry.text) {
            componentText = cacheEntry.text;
            console.log(`[Core] 从缓存加载 ${componentUrl}`);
        } else {
            console.log(`[Core] 正在加载 ${componentUrl}...`);
            const response = await fetch(componentUrl);
            if (!response.ok) throw new Error(`加载组件失败: ${response.status} ${response.statusText}`);
            componentText = await response.text();
            cacheEntry = componentCache.get(componentText) || {};
            cacheEntry.text = componentText;
            componentCache.set(componentUrl, cacheEntry);
            componentCache.set(componentText, cacheEntry);
            console.log("[Core] 组件加载完成.");
        }

        // 2. 解析组件结构 (使用缓存)
        const { template, script, style } = parseComponentStructure(componentText);

        // 3. 解析脚本 AST (使用缓存)
        let ast;
        if (cacheEntry.ast) {
            ast = cacheEntry.ast;
            // console.log("[Core] 从缓存获取脚本 AST");
        } else {
            ast = parseScriptWithAcorn(script);
            cacheEntry.ast = ast;
        }

        // **新增:** 4. 创建 emit 函数
        const emit = createEmitFunction(eventHandlers, componentName);

        // **修改:** 5. 执行脚本获取作用域 (注入 props 和 emit)
        const componentScope = executeScript(script, ast, initialProps, emit);

        // 6. 编译模板
        console.log(`[Core] 开始编译 ${componentName} 的模板...`);
        const fragment = document.createDocumentFragment();
        const tempDiv = document.createElement('div'); // 临时容器
        tempDiv.innerHTML = template.trim();
        // 将临时容器的子节点移动到 fragment
        while (tempDiv.firstChild) {
            fragment.appendChild(tempDiv.firstChild);
        }

        // 对 fragment 的顶级节点进行编译，传入组件名
        Array.from(fragment.childNodes).forEach(node => compileNode(node, componentScope, window.NueDirectives, componentName));
        console.log(`[Core] ${componentName} 模板编译完成.`);

        // 7. 注入样式 (使用缓存检查)
        injectStyles(style, componentUrl);

        // 8. 挂载到目标
        let mountedRootElement = null;
        // 查找编译后 fragment 中的第一个元素节点作为挂载的根
        mountedRootElement = fragment.querySelector('*'); // 或者 fragment.firstElementChild

        if (!mountedRootElement && fragment.childNodes.length > 0) {
             // 如果没有元素节点，但有其他节点（如文本节点），可能需要包裹一下
             // 或者，约定组件必须有一个根元素节点
             console.warn(`[Core] 组件 ${componentName} 编译后没有找到根元素节点，将尝试挂载整个 fragment 内容。`);
             // 在这种情况下，返回 fragment 可能更合适，但替换占位符会复杂些
             // 简单处理：取第一个子节点（可能是文本或注释）
             mountedRootElement = fragment.firstChild;
        }


        if (isPlaceholder) {
            // 如果是挂载到占位符，用 fragment 内容替换占位符
            // targetElement 是注释节点
            if (targetElement.parentNode) {
                 // 插入 fragment 的所有子节点
                 let currentNode = fragment.firstChild;
                 while(currentNode) {
                     const nextNode = currentNode.nextSibling;
                     targetElement.parentNode.insertBefore(currentNode, targetElement);
                     currentNode = nextNode;
                 }
                 // 理论上，此时 mountedRootElement 应该是插入的第一个非文本节点
                 // 重新查找第一个元素可能更可靠
                 mountedRootElement = targetElement.previousSibling;
                 while(mountedRootElement && mountedRootElement.nodeType !== Node.ELEMENT_NODE) {
                     mountedRootElement = mountedRootElement.previousSibling;
                 }
                 // 如果找不到元素，可能组件模板为空或只有文本
                 if (!mountedRootElement) mountedRootElement = targetElement.previousSibling; // 回退到第一个节点

                 // targetElement.parentNode.replaceChild(fragment, targetElement); // replaceChild 不适用于 DocumentFragment
                 // 移除占位符现在由调用者 (compileNode) 完成，因为它需要替换操作
                 console.log(`[Core] 组件 ${componentName} 内容已插入占位符位置。`);
            } else {
                 console.error(`[Core] 占位符 ${componentName} 已从 DOM 移除，无法挂载。`);
                 return null; // 无法挂载
            }
        } else {
            // 如果是挂载到元素，清空并附加
            targetElement.innerHTML = '';
            targetElement.appendChild(fragment);
            console.log(`[Core] 组件 ${componentName} 成功挂载到`, targetElement);
        }

        console.log(`[Core] ${componentName} (${componentUrl}) 挂载流程结束.`);
        // 返回实际挂载的第一个元素节点，供 compileNode 替换占位符使用
        // 注意：如果组件模板有多个根节点，这里只返回第一个元素
        return mountedRootElement instanceof Element ? mountedRootElement : null;


    } catch (error) {
        console.error(`[Core] 挂载组件 ${componentName} (${componentUrl}) 时发生错误:`, error);
        if (targetElement && !isPlaceholder) {
             targetElement.innerHTML = `<pre style="color: red;">加载或编译组件 ${componentName} 失败:\n${error.message}\n${error.stack || ''}</pre>`;
        } else if (isPlaceholder && targetElement.parentNode) {
            // 在占位符后插入错误信息
            const errorNode = document.createElement('div');
            errorNode.style.color = 'red';
            errorNode.textContent = `Error loading/mounting <${componentName}>: ${error.message}`;
            targetElement.parentNode.insertBefore(errorNode, targetElement.nextSibling);
        }
        return null; // 返回 null 表示失败
    }
}

// 暴露核心 API
window.NueCore = {
    mountComponent,
    createSignal, // 暴露给 directives.js 或外部使用
    createEffect,  // 暴露给 directives.js 或外部使用
    compileNode,    // 暴露给 directives.js 用于递归编译
    // **新增:** 暴露 evaluateExpression 给 directives.js 使用
    // evaluateExpression: (expression, scope, additionalArgs = {}) => {
    //     // 这里的实现需要和 directives.js 中的一致或调用它
    //     // 为了避免重复，让 directives.js 定义它，core.js 在需要时调用 window.NueDirectives.evaluateExpression
    //     if (window.NueDirectives && typeof window.NueDirectives.evaluateExpression === 'function') {
    //         return window.NueDirectives.evaluateExpression(expression, scope, additionalArgs);
    //     } else {
    //         console.error("evaluateExpression 未在 NueDirectives 中定义！");
    //         throw new Error("evaluateExpression is not available");
    //     }
    // }
};

console.log("core.js 加载完成，NueCore 对象已准备就绪。");

