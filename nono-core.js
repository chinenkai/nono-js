// nono-core.js

// ==================================
// 1. Signal 核心实现 (保持不变)
// ==================================
let currentEffect = null;

function createSignal(initialValue) {
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
                // 使用 [...subscribers] 创建副本，防止在迭代过程中修改 Set 导致问题
                [...subscribers].forEach(effect => effect());
            }
            return newValue;
        }
    }
    return signalAccessor;
}

function createEffect(fn) {
    const effect = () => {
        currentEffect = effect;
        try {
            fn();
        } finally {
            currentEffect = null;
        }
    };
    effect(); // 立即执行一次以建立初始依赖
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
        const ast = acorn.parse(scriptContent, {
            ecmaVersion: 2020,
            sourceType: "module",
            allowReturnOutsideFunction: true // 允许顶层 return
        });
        console.log("Acorn 解析成功.");
        return ast;
    } catch (error) {
        console.error("Acorn 解析脚本失败:", error);
        console.error("问题脚本:\n", scriptContent);
        return null;
    }
}


/**
 * 执行组件脚本，获取其作用域
 * @param {string} scriptContent 脚本字符串
 * @param {object} ast Acorn 解析出的 AST (可选, 当前未使用，但保留以备将来分析)
 * @param {object} [initialProps={}] 父组件传递的 Props 对象 (键是 prop 名称，值是 Signal 或静态值)
 * @param {Function} [emit=()=>{}] 子组件用于触发事件的函数
 * @returns {object} 组件的作用域对象 (由脚本显式 return 返回)
 */
function executeScript(scriptContent, ast, initialProps = {}, emit = () => console.warn("emit 函数未提供")) {
    // ast 参数当前未使用，但保留接口
    if (!scriptContent.trim()) {
        console.log("脚本内容为空，返回空作用域。");
        return {}; // 如果没有 script 标签，返回空对象
    }
    if (ast === null && scriptContent.trim()) { // 只有在脚本不为空但解析失败时才警告
        console.warn("由于脚本解析失败，跳过执行。将返回空作用域。");
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
            if (typeof componentScope === 'undefined' && scriptContent.includes('return')) {
                 console.warn("提示：脚本包含 return 语句，但似乎未在顶层返回对象。");
            } else if (typeof componentScope === 'undefined' && !scriptContent.includes('return')) {
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
 * 创建供子组件使用的 emit 函数
 * @param {object} eventHandlers - 父组件提供的事件处理器映射 { eventName: handlerFunc }
 * @param {string} componentName - 用于日志记录的组件名
 * @returns {Function} emit 函数 (eventName, payload) => void
 */
function createEmitFunction(eventHandlers, componentName = '子组件') {
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
 * 编译 DOM 节点，处理指令和插值
 * @param {Node} node 当前处理的 DOM 节点
 * @param {object} scope 组件的作用域对象
 * @param {object} directiveHandlers 包含指令处理函数的对象 (来自 nono-directives.js)
 * @param {string} [parentComponentName='根组件'] 父组件名称，用于日志
 */
function compileNode(node, scope, directiveHandlers, parentComponentName = '根组件') {
    // 确保指令处理器已加载
    if (!directiveHandlers || typeof directiveHandlers.evaluateExpression !== 'function') {
        console.error(`[${parentComponentName}] 指令处理器 (NueDirectives) 或 evaluateExpression 未准备好，编译中止。`);
        return;
    }

    // 1. 处理元素节点 (Element Node)
    if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node; // 类型断言，方便使用 Element API
        const tagName = element.tagName.toLowerCase();

        // 1.1 检查是否是子组件标签 (简单约定：包含连字符，且不是内置标签)
        if (tagName.includes('-') && !['template', 'script', 'style'].includes(tagName)) {
            console.log(`[${parentComponentName}] 发现潜在子组件标签: <${tagName}>`);
            const componentUrl = `${tagName}.nue`; // 约定组件名对应文件名

            const initialProps = {};
            const eventHandlers = {};
            const attributesToRemove = []; // 记录需要移除的属性

            // 1.1.1 解析 Props 和事件监听器
            for (const attr of Array.from(element.attributes)) {
                const attrName = attr.name;
                const attrValue = attr.value;

                if (attrName.startsWith(':')) { // 动态 Prop (属性绑定)
                    const propName = attrName.substring(1);
                    const expression = attrValue;
                    console.log(`[${parentComponentName}] 解析动态 Prop :${propName}="${expression}"`);
                    const propSignal = createSignal(undefined);
                    createEffect(() => {
                        try {
                            const value = directiveHandlers.evaluateExpression(expression, scope);
                            propSignal(value);
                        } catch (error) {
                            console.error(`[${parentComponentName}] 计算 Prop "${propName}" 表达式 "${expression}" 出错:`, error);
                            propSignal(undefined);
                        }
                    });
                    initialProps[propName] = propSignal;
                    attributesToRemove.push(attrName);

                } else if (attrName.startsWith('@')) { // 事件监听器
                    const eventName = attrName.substring(1);
                    const handlerExpression = attrValue;
                    console.log(`[${parentComponentName}] 解析事件监听 @${eventName}="${handlerExpression}"`);
                    eventHandlers[eventName] = (payload) => {
                        console.log(`[${parentComponentName}] 接收到子组件事件 "${eventName}"，执行: ${handlerExpression}`, payload);
                        try {
                            const context = Object.create(scope);
                            context.$event = payload;
                            // --- 子组件事件处理器的执行逻辑 ---
                            // 与普通元素事件处理类似，需要检查是否需要调用返回的函数
                            const result = directiveHandlers.evaluateExpression(handlerExpression, context);
                            const trimmedHandler = handlerExpression.trim();
                            const isSimpleIdentifier = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmedHandler);

                            if (isSimpleIdentifier && typeof result === 'function') {
                                console.log(`[${parentComponentName}] (子组件事件) 检测到简单函数名 "${trimmedHandler}"，将调用返回的函数。`);
                                result.call(scope, payload); // 将 payload 作为参数传递给处理器
                            } else {
                                console.log(`[${parentComponentName}] (子组件事件) 表达式 "${trimmedHandler}" 已由 evaluateExpression 执行。`);
                            }
                            // --- 结束：子组件事件处理器的执行逻辑 ---
                        } catch (error) {
                            console.error(`[${parentComponentName}] 执行子组件事件处理器 "${handlerExpression}" 出错:`, error);
                        }
                    };
                    attributesToRemove.push(attrName);

                } else { // 静态 Prop
                    console.log(`[${parentComponentName}] 解析静态 Prop ${attrName}="${attrValue}"`);
                    initialProps[attrName] = attrValue;
                    attributesToRemove.push(attrName);
                }
            }

            // 移除已处理的特殊属性
            attributesToRemove.forEach(attrName => element.removeAttribute(attrName));

            // 1.1.2 异步挂载子组件
            const placeholder = document.createComment(`component: ${tagName}`);
            // 确保在替换前 placeholder 有父节点
            if (!element.parentNode) {
                console.error(`[${parentComponentName}] 尝试挂载子组件 <${tagName}> 时，其原始位置已脱离 DOM。`);
                return; // 无法挂载
            }
            element.parentNode.replaceChild(placeholder, element);

            mountComponent(componentUrl, placeholder, initialProps, eventHandlers, tagName /*传递组件名用于日志*/)
                .then(mountedNode => {
                    if (mountedNode) {
                        console.log(`[${parentComponentName}] 子组件 <${tagName}> 挂载完成 (节点已由 mountComponent 插入).`);
                    } else {
                        console.error(`[${parentComponentName}] 子组件 <${tagName}> 挂载失败 (mountComponent 未能成功返回节点). 请检查之前的日志获取详细错误信息.`);
                    }
                })
                .catch(error => {
                    console.error(`[${parentComponentName}] 调用 mountComponent 挂载子组件 <${tagName}> (${componentUrl}) 时发生异步错误:`, error);
                });

            // 子组件已交由 mountComponent 处理，不再递归编译此节点
            return;
        }

        // 1.2 处理结构性指令 (n-if, n-for) - 这些指令会改变 DOM 结构，优先处理
        const nIfAttr = element.getAttribute('n-if');
        if (nIfAttr !== null) {
            directiveHandlers.handleNIf(element, nIfAttr, scope, compileNode, directiveHandlers, parentComponentName);
            return;
        }

        const nForAttr = element.getAttribute('n-for');
        if (nForAttr !== null) {
            directiveHandlers.handleNFor(element, nForAttr, scope, compileNode, directiveHandlers, parentComponentName);
            return;
        }

        // 1.3 处理其他元素指令和属性 (在元素确定会渲染后处理)
        const attributesToRemoveAfterProcessing = []; // 收集本轮要移除的属性
        const attributes = Array.from(element.attributes); // 复制一份，因为后面会修改

        for (const attr of attributes) {
            const attrName = attr.name;
            const attrValue = attr.value;

            // 1.3.1 属性绑定 (:attribute)
            if (attrName.startsWith(':')) {
                const actualAttrName = attrName.substring(1);
                if (directiveHandlers.handleAttributeBinding) {
                    directiveHandlers.handleAttributeBinding(element, actualAttrName, attrValue, scope, parentComponentName);
                } else {
                     console.warn(`[${parentComponentName}] 未找到 handleAttributeBinding 处理器`);
                }
                attributesToRemoveAfterProcessing.push(attrName);
            }
            // 1.3.2 事件绑定 (@event)
            else if (attrName.startsWith('@')) {
                const eventName = attrName.substring(1);
                const handlerExpression = attrValue.trim(); // 去除前后空格
                attributesToRemoveAfterProcessing.push(attrName);

                element.addEventListener(eventName, (event) => {
                    console.log(`[${parentComponentName}] 触发事件 ${eventName}，执行代码: ${handlerExpression}`);
                    try {
                        const context = Object.create(scope);
                        context.$event = event; // 将原生 event 对象放入上下文

                        // ================== 修改后的事件处理逻辑 ==================
                        const result = directiveHandlers.evaluateExpression(handlerExpression, context);

                        // 检查表达式是否看起来像一个简单的函数名 (不含括号)
                        // 并且 evaluateExpression 的结果确实是一个函数
                        const isSimpleIdentifier = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(handlerExpression);

                        if (isSimpleIdentifier && typeof result === 'function') {
                            console.log(`[${parentComponentName}] 检测到简单函数名 "${handlerExpression}"，将调用返回的函数。`);
                            // 调用 evaluateExpression 返回的函数
                            // 使用 call(scope) 确保函数内部的 this 指向组件作用域
                            result.call(scope, event); // 将 event 作为参数传递
                        } else {
                            // 如果表达式本身包含括号，或者结果不是函数，
                            // 那么 evaluateExpression 的执行本身就应该是预期的操作。
                            console.log(`[${parentComponentName}] 表达式 "${handlerExpression}" 已由 evaluateExpression 执行。`);
                        }
                        // =======================================================

                    } catch (error) {
                        // evaluateExpression 内部会打印错误，这里可以捕获以防万一
                        console.error(`[${parentComponentName}] 执行事件处理器代码 "${handlerExpression}" 时捕获到顶层错误:`, error);
                    }
                });
            }
            // 1.3.3 双向绑定 (n-model)
            else if (attrName === 'n-model') {
                 if (directiveHandlers.handleNModel) {
                    directiveHandlers.handleNModel(element, attrValue, scope, parentComponentName);
                 } else {
                     console.warn(`[${parentComponentName}] 未找到 handleNModel 处理器`);
                 }
                 attributesToRemoveAfterProcessing.push(attrName);
            }
            // 1.3.4 条件显示 (n-show)
            else if (attrName === 'n-show') {
                 if (directiveHandlers.handleNShow) {
                    directiveHandlers.handleNShow(element, attrValue, scope, parentComponentName);
                 } else {
                     console.warn(`[${parentComponentName}] 未找到 handleNShow 处理器`);
                 }
                 attributesToRemoveAfterProcessing.push(attrName);
            }
            // 1.3.5 HTML 绑定 (n-html)
            else if (attrName === 'n-html') {
                 if (directiveHandlers.handleNHtml) {
                    directiveHandlers.handleNHtml(element, attrValue, scope, parentComponentName);
                 } else {
                     console.warn(`[${parentComponentName}] 未找到 handleNHtml 处理器`);
                 }
                 attributesToRemoveAfterProcessing.push(attrName);
            }
        }

        // 1.4 移除所有已处理的指令属性
        attributesToRemoveAfterProcessing.forEach(attrName => element.removeAttribute(attrName));

        // 1.5 递归处理子节点 (如果元素本身未被 n-if/n-for 移除)
        // 使用 Array.from 创建副本，防止子节点在编译过程中被修改导致迭代问题
        Array.from(element.childNodes).forEach(child => compileNode(child, scope, directiveHandlers, parentComponentName));

    }
    // 2. 处理文本节点 (Text Node) - 处理插值 {{ expression }}
    else if (node.nodeType === Node.TEXT_NODE) {
        const textContent = node.textContent || '';
        const mustacheRegex = /\{\{([^}]+)\}\}/g; // 匹配 {{...}}

        // 优化：如果文本节点不包含插值语法，直接跳过
        if (!mustacheRegex.test(textContent)) {
            return;
        }

        const segments = []; // 存储文本片段和响应式占位符
        let lastIndex = 0;
        let match;
        mustacheRegex.lastIndex = 0; // 重置正则表达式的 lastIndex

        while ((match = mustacheRegex.exec(textContent)) !== null) {
            // 添加插值前的静态文本部分
            if (match.index > lastIndex) {
                segments.push(document.createTextNode(textContent.substring(lastIndex, match.index)));
            }

            // 处理插值表达式
            const expression = match[1].trim();
            const placeholderNode = document.createTextNode(''); // 创建一个空的文本节点作为占位符
            segments.push(placeholderNode);

            // 使用 createEffect 来动态更新这个占位符节点的内容
            createEffect(() => {
                try {
                    // 使用 directiveHandlers.evaluateExpression 统一处理表达式求值
                    const value = directiveHandlers.evaluateExpression(expression, scope);
                    // 将计算结果转为字符串，处理 null/undefined 情况
                    placeholderNode.textContent = value === undefined || value === null ? '' : String(value);
                } catch (error) {
                    console.error(`[${parentComponentName}] 计算表达式 "{{${expression}}}" 出错:`, error);
                    placeholderNode.textContent = `{{表达式错误}}`; // 在页面上显示错误提示
                }
            });

            lastIndex = mustacheRegex.lastIndex; // 更新下次匹配的起始位置
        }

        // 添加最后一个插值后的静态文本部分
        if (lastIndex < textContent.length) {
            segments.push(document.createTextNode(textContent.substring(lastIndex)));
        }

        // 如果有解析出片段，用这些片段替换原始文本节点
        if (segments.length > 0 && node.parentNode) {
            const parent = node.parentNode;
            segments.forEach(segment => parent.insertBefore(segment, node));
            parent.removeChild(node); // 移除原始的包含 {{...}} 的文本节点
        }
    }
    // 3. 其他节点类型 (如注释 Comment Node) - 通常直接忽略
}



/**
 * 将 CSS 样式注入到文档头部
 * @param {string} css CSS 字符串
 * @param {string} componentUrl 用于生成唯一 ID，防止重复注入
 */
function injectStyles(css, componentUrl) {
    if (!css || !css.trim()) return;
    // 基于 URL 生成一个相对稳定的 ID，移除特殊字符
    const styleId = `nono-style-${componentUrl.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
    if (document.getElementById(styleId)) {
        // console.log(`样式 ${styleId} 已存在，跳过注入。`);
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
 * 挂载组件到目标位置
 * @param {string} componentUrl .nue 文件的 URL
 * @param {string | Element | Comment} target - CSS 选择器、目标元素或占位符注释节点
 * @param {object} [initialProps={}] - 传递给组件的 Props
 * @param {object} [eventHandlers={}] - 父组件提供的事件处理器
 * @param {string} [componentName='组件'] - 组件名称，用于日志
 * @returns {Promise<Element | null>} 返回挂载的组件根元素 (第一个 Element 节点)，如果失败则返回 null
 */
async function mountComponent(componentUrl, target, initialProps = {}, eventHandlers = {}, componentName = '组件') {
    console.log(`[核心] 开始挂载组件: ${componentName} (${componentUrl})`);
    let targetElement = null; // 挂载的目标 DOM 节点
    let isPlaceholder = false; // 标记 target 是否是占位符注释

    // 1. 解析挂载目标
    if (typeof target === 'string') {
        targetElement = document.querySelector(target);
        if (!targetElement) {
            console.error(`[核心] 挂载失败：找不到目标元素 "${target}"`);
            return null;
        }
    } else if (target instanceof Element) {
        targetElement = target;
    } else if (target instanceof Comment) { // 支持挂载到注释占位符
        targetElement = target;
        isPlaceholder = true;
        if (!targetElement.parentNode) {
             console.error(`[核心] 挂载失败：注释占位符已脱离 DOM`);
             return null;
        }
    } else {
         console.error(`[核心] 挂载失败：无效的目标`, target);
         return null;
    }

    // 2. 检查依赖 (Acorn, 指令处理器)
    if (typeof window.acorn === 'undefined') {
        console.error("[核心] Acorn 解析器 (acorn.js) 未加载！");
        if (targetElement && !isPlaceholder) targetElement.innerHTML = `<p style="color: red;">错误：acorn.js 未加载</p>`;
        else if (isPlaceholder) targetElement.parentNode?.insertBefore(document.createTextNode(' [Acorn 加载错误] '), targetElement.nextSibling);
        return null;
    }
     if (typeof window.NueDirectives === 'undefined' || typeof window.NueDirectives.evaluateExpression !== 'function') {
         console.error("[核心] 指令处理器 (nono-directives.js) 或其 evaluateExpression 未加载！");
         if (targetElement && !isPlaceholder) targetElement.innerHTML = `<p style="color: red;">错误：nono-directives.js 未加载</p>`;
         else if (isPlaceholder) targetElement.parentNode?.insertBefore(document.createTextNode(' [Directives 加载错误] '), targetElement.nextSibling);
         return null;
    }


    try {
        // 3. 加载组件文件 (使用缓存)
        let componentText;
        let cacheEntry = componentCache.get(componentUrl);
        if (cacheEntry && cacheEntry.text) {
            componentText = cacheEntry.text;
            console.log(`[核心] 从缓存加载 ${componentUrl}`);
        } else {
            console.log(`[核心] 正在加载 ${componentUrl}...`);
            const response = await fetch(componentUrl);
            if (!response.ok) throw new Error(`加载组件失败: ${response.status} ${response.statusText}`);
            componentText = await response.text();
            // 使用 componentUrl 作为主键缓存文本和后续解析结果
            cacheEntry = { text: componentText };
            componentCache.set(componentUrl, cacheEntry);
            console.log("[核心] 组件加载完成.");
        }

        // 4. 解析组件结构 (使用缓存)
        if (!cacheEntry.structure) {
            cacheEntry.structure = parseComponentStructure(componentText);
        }
        const { template, script, style } = cacheEntry.structure;

        // 5. 解析脚本 AST (使用缓存)
        if (!cacheEntry.ast && script.trim()) { // 只有在有脚本时才解析
            cacheEntry.ast = parseScriptWithAcorn(script);
        }
        const ast = cacheEntry.ast; // 可能为 null

        // 6. 创建 emit 函数
        const emit = createEmitFunction(eventHandlers, componentName);

        // 7. 执行脚本获取作用域 (注入 props 和 emit)
        const componentScope = executeScript(script, ast, initialProps, emit);

        // 8. 编译模板
        console.log(`[核心] 开始编译 ${componentName} 的模板...`);
        const fragment = document.createDocumentFragment();
        const tempDiv = document.createElement('div'); // 临时容器解析 HTML
        tempDiv.innerHTML = template.trim();
        // 将临时容器的子节点移动到 fragment
        while (tempDiv.firstChild) {
            fragment.appendChild(tempDiv.firstChild);
        }

        // 对 fragment 的顶级节点进行编译，传入组件名和指令处理器
        Array.from(fragment.childNodes).forEach(node => compileNode(node, componentScope, window.NueDirectives, componentName));
        console.log(`[核心] ${componentName} 模板编译完成.`);

        // 9. 注入样式 (内部会检查是否已注入)
        injectStyles(style, componentUrl);

        // 10. 挂载到目标
        let mountedRootElement = null;
        // 查找编译后 fragment 中的第一个元素节点作为挂载的根
        // fragment.firstElementChild 在没有元素子节点时为 null
        mountedRootElement = fragment.querySelector('*') || fragment.firstChild; // 回退到第一个子节点（可能是文本）

        if (isPlaceholder) {
            // 如果是挂载到占位符，用 fragment 内容替换占位符
            const parent = targetElement.parentNode; // 在插入前获取父节点
            if (parent) {
                 // 插入 fragment 的所有子节点到占位符之前
                 parent.insertBefore(fragment, targetElement);
                 // 找到实际插入的第一个元素节点（如果存在）
                 let firstInsertedNode = targetElement.previousSibling;
                 while(firstInsertedNode && firstInsertedNode.nodeType !== Node.ELEMENT_NODE) {
                     firstInsertedNode = firstInsertedNode.previousSibling;
                 }
                 mountedRootElement = firstInsertedNode; // 可能为 null
                 // 移除占位符注释节点
                 parent.removeChild(targetElement);
                 console.log(`[核心] 组件 ${componentName} 内容已替换占位符。`);
            } else {
                 // 这理论上不应该发生，因为前面检查过 parentNode
                 console.error(`[核心] 占位符 ${componentName} 的父节点丢失，无法挂载。`);
                 return null; // 无法挂载
            }
        } else {
            // 如果是挂载到元素，清空并附加
            targetElement.innerHTML = '';
            targetElement.appendChild(fragment);
            // 挂载后，第一个元素子节点就是根元素
            mountedRootElement = targetElement.firstElementChild;
            console.log(`[核心] 组件 ${componentName} 成功挂载到`, targetElement);
        }

        console.log(`[核心] ${componentName} (${componentUrl}) 挂载流程结束.`);
        // 返回实际挂载的第一个元素节点（或第一个节点），供子组件逻辑使用
        return mountedRootElement instanceof Element ? mountedRootElement : null; // 确保返回的是 Element 或 null

    } catch (error) {
        console.error(`[核心] 挂载组件 ${componentName} (${componentUrl}) 时发生错误:`, error);
        const errorMsg = `加载/编译组件 ${componentName} 失败: ${error.message}`;
        if (targetElement && !isPlaceholder) {
             targetElement.innerHTML = `<pre style="color: red;">${errorMsg}\n${error.stack || ''}</pre>`;
        } else if (isPlaceholder && targetElement.parentNode) {
            // 在占位符后插入错误信息
            const errorNode = document.createElement('div');
            errorNode.style.color = 'red'; errorNode.textContent = errorMsg;
            targetElement.parentNode.insertBefore(errorNode, targetElement.nextSibling);
        }
        return null; // 返回 null 表示失败
    }
}

// 暴露核心 API 到全局
window.NueCore = {
    mountComponent,
    createSignal, // 暴露给组件脚本和指令
    createEffect,  // 暴露给指令等
    compileNode,    // 暴露给指令（如 n-if, n-for）进行递归编译
    // 注意：evaluateExpression 由 nono-directives.js 提供并挂载到 NueDirectives 上
};

console.log("nono-core.js 加载完成，NueCore 对象已准备就绪。");

