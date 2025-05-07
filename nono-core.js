// nono-core.js

// ==================================
// 1. Signal 核心实现
// ==================================
let currentEffect = null; // 当前正在执行的副作用函数

/**
 * 创建一个响应式信号。
 * @param {*} initialValue 初始值
 * @returns {Function}信号访问器函数。无参数调用时读取值，有参数调用时设置值。
 */
function createSignal(initialValue) {
    let value = initialValue;
    const subscribers = new Set(); // 存储订阅该信号的副作用函数

    function signalAccessor(newValue) {
        if (arguments.length === 0) { // 读取操作
            if (currentEffect) {
                subscribers.add(currentEffect); // 依赖收集
            }
            return value;
        } else { // 写入操作
            if (value !== newValue) {
                value = newValue;
                // 触发所有订阅的副作用函数，使用副本以避免迭代问题
                [...subscribers].forEach(effect => effect());
            }
            return newValue;
        }
    }
    return signalAccessor;
}

/**
 * 创建一个副作用函数，当其依赖的信号变化时会自动重新执行。
 * @param {Function} fn 要执行的副作用函数体
 */
function createEffect(fn) {
    const effect = () => {
        currentEffect = effect; // 设置当前副作用，以便信号进行依赖收集
        try {
            fn(); // 执行副作用函数
        } finally {
            currentEffect = null; // 清理当前副作用
        }
    };
    effect(); // 立即执行一次以建立初始依赖关系
}

// ==================================
// 2. 组件相关缓存与注册表
// ==================================
const componentCache = new Map(); // 缓存已加载和解析的组件数据 { url: { text, structure, ast } }
const componentCleanupRegistry = new WeakMap(); // 存储组件根元素与其 onUnmount 回调的映射

// ==================================
// 3. 组件处理核心函数
// ==================================

/**
 * 解析 .nue 文件内容，提取 template, script, style。
 * @param {string} text .nue 文件文本内容
 * @returns {{template: string, script: string, style: string}} 包含各部分内容的对象
 */
function parseComponentStructure(text) {
    // 检查缓存
    const cached = componentCache.get(text);
    if (cached && cached.structure) {
        return cached.structure;
    }

    // console.log("核心：解析组件结构..."); // 保留少量关键日志

    let template = '';
    let script = '';
    let style = '';

    // 改进的 template 解析逻辑，尝试通过字符串截取避免内部 "</template>" 干扰
    const firstTemplateStartTag = text.indexOf('<template');
    if (firstTemplateStartTag !== -1) {
        const firstTemplateStartTagEnd = text.indexOf('>', firstTemplateStartTag);
        if (firstTemplateStartTagEnd !== -1) {
            const lastTemplateEndTag = text.lastIndexOf('</template>');
            if (lastTemplateEndTag !== -1 && lastTemplateEndTag > firstTemplateStartTagEnd) {
                template = text.substring(firstTemplateStartTagEnd + 1, lastTemplateEndTag).trim();
            } else {
                // console.warn("核心：未能通过字符串截取找到有效 template 内容，回退到正则匹配。");
                const templateMatchFallback = text.match(/<template\b[^>]*>([\s\S]*?)<\/template\s*>/i);
                template = templateMatchFallback ? templateMatchFallback[1].trim() : '';
            }
        }
    }

    // script 和 style 的正则解析通常较为稳定
    const scriptMatch = text.match(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/i);
    script = scriptMatch ? scriptMatch[1].trim() : '';
    
    const styleMatch = text.match(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/i);
    style = styleMatch ? styleMatch[1].trim() : '';

    const structure = { template, script, style };

    // 更新缓存
    let cacheEntry = componentCache.get(text) || {};
    cacheEntry.structure = structure;
    componentCache.set(text, cacheEntry);

    return structure;
}

/**
 * 使用 Acorn 解析脚本内容为 AST (抽象语法树)。
 * @param {string} scriptContent 脚本字符串
 * @returns {object | null} Acorn AST 对象，或在失败时返回 null
 */
function parseScriptWithAcorn(scriptContent) {
    if (!window.acorn) {
        console.error("核心错误：Acorn 解析器 (acorn.js) 未加载！");
        return null;
    }
    // console.log("核心：使用 Acorn 解析脚本...");
    try {
        const ast = acorn.parse(scriptContent, {
            ecmaVersion: 2020,
            sourceType: "module",
            allowReturnOutsideFunction: true // 允许顶层 return
        });
        // console.log("核心：Acorn 解析成功.");
        return ast;
    } catch (error) {
        console.error("核心错误：Acorn 解析脚本失败:", error);
        console.error("核心错误：问题脚本内容:\n", scriptContent);
        return null;
    }
}

/**
 * 执行组件脚本，获取其作用域。
 * @param {string} scriptContent 脚本字符串
 * @param {object} ast Acorn 解析出的 AST (当前未使用，保留)
 * @param {object} [initialProps={}] 父组件传递的 Props
 * @param {Function} [emit=()=>{}] 子组件用于触发事件的函数
 * @returns {object} 组件的作用域对象
 */
function executeScript(scriptContent, ast, initialProps = {}, emit = () => console.warn("核心警告：emit 函数未在执行脚本时提供")) {
    if (!scriptContent.trim()) {
        return {}; // 无脚本内容，返回空作用域
    }
    if (ast === null && scriptContent.trim()) {
        console.warn("核心警告：由于脚本解析失败，跳过执行。返回空作用域。");
        return {};
    }

    // console.log("核心：准备执行脚本 (注入 props 和 emit)...");
    try {
        const scriptFunction = new Function('createSignal', 'props', 'emit', scriptContent);
        const componentScope = scriptFunction(createSignal, initialProps, emit);

        if (typeof componentScope === 'object' && componentScope !== null) {
            // console.log("核心：脚本执行完毕，返回作用域:", componentScope);
            return componentScope;
        } else {
            console.warn("核心警告：脚本已执行，但未返回对象作为作用域。请确保脚本末尾有 'return { ... };'。返回空作用域。");
            return {};
        }
    } catch (error) {
        console.error("核心错误：执行组件脚本时出错:", error);
        console.error("核心错误：脚本内容:\n", scriptContent);
        return {};
    }
}

/**
 * 创建供子组件使用的 emit 函数。
 * @param {object} eventHandlers - 父组件提供的事件处理器映射 { eventName: handlerFunc }
 * @param {string} componentName - 用于日志记录的组件名
 * @returns {Function} emit 函数 (eventName, payload) => void
 */
function createEmitFunction(eventHandlers, componentName = '子组件') {
    return function emit(eventName, payload) {
        // console.log(`核心：${componentName} 发出事件: ${eventName}`, payload);
        const handler = eventHandlers[eventName];
        if (handler && typeof handler === 'function') {
            try {
                handler(payload);
            } catch (error)
                {
                console.error(`核心错误：执行 ${componentName} 的事件 "${eventName}" 处理器时出错:`, error);
            }
        } else {
            // console.warn(`核心警告：${componentName} 尝试发出未被监听的事件: ${eventName}`);
        }
    };
}

/**
 * 将 kebab-case 字符串转换为 camelCase。
 * @param {string} kebabCase 输入字符串
 * @returns {string} camelCase 字符串
 */
function kebabToCamel(kebabCase) {
    return kebabCase.replace(/-([a-z])/g, (match, letter) => letter.toUpperCase());
}

/**
 * 编译 DOM 节点，处理指令和插值。
 * @param {Node} node 当前处理的 DOM 节点
 * @param {object} scope 组件的作用域对象
 * @param {object} directiveHandlers 包含指令处理函数的对象
 * @param {string} [parentComponentName='根组件'] 父组件名称，用于日志
 */
function compileNode(node, scope, directiveHandlers, parentComponentName = '根组件') {
    if (!directiveHandlers || typeof directiveHandlers.evaluateExpression !== 'function') {
        console.error(`核心错误：[${parentComponentName}] 指令处理器或 evaluateExpression 未准备好，编译中止。`);
        return;
    }

    // 1. 处理元素节点
    if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node;
        const tagName = element.tagName.toLowerCase();

        // 1.1 处理子组件标签
        if (tagName.includes('-') && !['template', 'script', 'style', 'slot'].includes(tagName)) {
            // console.log(`核心：[${parentComponentName}] 发现子组件标签: <${tagName}>`);
            const componentUrl = `${tagName}.nue`;
            const initialProps = {};
            const eventHandlers = {};
            const attributesToRemove = [];

            // 解析 Props 和事件
            for (const attr of Array.from(element.attributes)) {
                const attrName = attr.name;
                const attrValue = attr.value;
                if (attrName.startsWith(':')) { // 动态 Prop
                    const rawPropName = attrName.substring(1);
                    const camelCasePropName = kebabToCamel(rawPropName);
                    const expression = attrValue;
                    const propSignal = createSignal(undefined);
                    createEffect(() => {
                        try {
                            propSignal(directiveHandlers.evaluateExpression(expression, scope));
                        } catch (error) {
                            console.error(`核心错误：[${parentComponentName}] 计算动态 Prop "${rawPropName}" (${attrName}) 表达式 "${expression}" 出错:`, error);
                            propSignal(undefined);
                        }
                    });
                    initialProps[camelCasePropName] = propSignal;
                    attributesToRemove.push(attrName);
                } else if (attrName.startsWith('@')) { // 事件监听
                    const eventName = attrName.substring(1);
                    const handlerExpression = attrValue;
                    eventHandlers[eventName] = (payload) => {
                        try {
                            const context = Object.create(scope);
                            context.$event = payload;
                            const result = directiveHandlers.evaluateExpression(handlerExpression, context);
                            if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(handlerExpression.trim()) && typeof result === 'function') {
                                result.call(scope, payload);
                            }
                        } catch (error) {
                            console.error(`核心错误：[${parentComponentName}] 执行子组件事件处理器 "${handlerExpression}" 出错:`, error);
                        }
                    };
                    attributesToRemove.push(attrName);
                } else { // 静态 Prop
                    initialProps[kebabToCamel(attrName)] = attrValue;
                }
            }
            
            // 解析插槽内容
            const parsedSlots = {}; 
            const slotContentContainer = document.createDocumentFragment();
            const tempChildNodes = Array.from(element.childNodes); // 创建快照以安全移动
            tempChildNodes.forEach(cn => slotContentContainer.appendChild(cn));

            const rawSlotContents = { default: [] }; 
            Array.from(slotContentContainer.childNodes).forEach(childNode => {
                if (childNode.nodeType === Node.ELEMENT_NODE && childNode.tagName.toLowerCase() === 'template') {
                    if (childNode.hasAttribute('slot')) {
                        let slotNameAttr = (childNode.getAttribute('slot') || '').trim();
                        if (!slotNameAttr) { // 空 slot 名视为默认
                            const templateContent = childNode.content;
                            if (templateContent) Array.from(templateContent.childNodes).forEach(c => rawSlotContents.default.push(c.cloneNode(true)));
                        } else {
                            if (!rawSlotContents[slotNameAttr]) rawSlotContents[slotNameAttr] = [];
                            const templateContent = childNode.content; 
                            if (templateContent) Array.from(templateContent.childNodes).forEach(c => rawSlotContents[slotNameAttr].push(c.cloneNode(true)));
                        }
                    } else { // 无 slot 属性的 template 内容归入默认插槽
                        const templateContent = childNode.content;
                        if (templateContent) Array.from(templateContent.childNodes).forEach(c => rawSlotContents.default.push(c.cloneNode(true)));
                    }
                } else if (!(childNode.nodeType === Node.TEXT_NODE && childNode.nodeValue.trim() === '')) { 
                    // 非空白文本节点和非 template 元素归入默认插槽
                    rawSlotContents.default.push(childNode.cloneNode(true)); 
                }
            });

            // 编译插槽内容
            for (const sName in rawSlotContents) {
                const compiledSlotFragment = document.createDocumentFragment();
                if (rawSlotContents[sName].length > 0) {
                    rawSlotContents[sName].forEach(n => compiledSlotFragment.appendChild(n)); 
                    Array.from(compiledSlotFragment.childNodes).forEach(nodeToCompile => {
                        compileNode(nodeToCompile, scope, directiveHandlers, `${parentComponentName} (slot '${sName}')`);
                    });
                }
                parsedSlots[sName] = compiledSlotFragment; 
            }

            attributesToRemove.forEach(attrName => element.removeAttribute(attrName));
            const placeholder = document.createComment(`component-placeholder: ${tagName}`);
            if (!element.parentNode) {
                console.error(`核心错误：[${parentComponentName}] 子组件 <${tagName}> 在替换为占位符前已无父节点。`);
                return;
            }
            element.parentNode.replaceChild(placeholder, element);

            // 异步挂载子组件
            mountComponent(componentUrl, placeholder, initialProps, eventHandlers, tagName, parsedSlots)
                .catch(error => console.error(`核心错误：[${parentComponentName}] 异步挂载子组件 <${tagName}> (${componentUrl}) 失败:`, error));
            return; // 子组件已处理
        }

        // 1.2 处理结构性指令 (n-if, n-for)
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

        // 1.3 处理 <slot> 标签 (在子组件模板内部渲染插槽)
        if (tagName === 'slot') {
            const slotName = element.getAttribute('name') || 'default';
            const providedContentFragment = scope.$slots && scope.$slots[slotName];
            const parentOfSlot = element.parentNode;

            if (parentOfSlot) {
                if (providedContentFragment && providedContentFragment.childNodes.length > 0) {
                    parentOfSlot.insertBefore(providedContentFragment.cloneNode(true), element); // 插入父组件提供的内容
                } else { // 使用后备内容
                    const fallbackFragment = document.createDocumentFragment();
                    while (element.firstChild) fallbackFragment.appendChild(element.firstChild);
                    Array.from(fallbackFragment.childNodes).forEach(fallbackNode => {
                        compileNode(fallbackNode, scope, directiveHandlers, `${parentComponentName} (slot '${slotName}' fallback)`);
                    });
                    parentOfSlot.insertBefore(fallbackFragment, element);
                }
                parentOfSlot.removeChild(element); // 移除 <slot> 标签
            } else {
                console.warn(`核心警告：[${parentComponentName}] <slot name="${slotName}"> 标签无父节点，无法渲染。`);
            }
            return; 
        }

        // 1.4 处理其他元素指令和属性
        const attributesToRemoveAfterProcessing = [];
        for (const attr of Array.from(element.attributes)) {
            const attrName = attr.name;
            const attrValue = attr.value;
            if (attrName.startsWith(':')) {
                if (directiveHandlers.handleAttributeBinding) directiveHandlers.handleAttributeBinding(element, attrName.substring(1), attrValue, scope, parentComponentName);
                attributesToRemoveAfterProcessing.push(attrName);
            } else if (attrName.startsWith('@')) {
                const eventName = attrName.substring(1);
                element.addEventListener(eventName, (event) => {
                    try {
                        const context = Object.create(scope);
                        context.$event = event;
                        const result = directiveHandlers.evaluateExpression(attrValue, context);
                        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(attrValue.trim()) && typeof result === 'function') {
                            result.call(scope, event);
                        }
                    } catch (error) {
                        console.error(`核心错误：[${parentComponentName}] 执行事件处理器 "${attrValue}" 出错:`, error);
                    }
                });
                attributesToRemoveAfterProcessing.push(attrName);
            } else if (attrName === 'n-model' && directiveHandlers.handleNModel) {
                directiveHandlers.handleNModel(element, attrValue, scope, parentComponentName);
                attributesToRemoveAfterProcessing.push(attrName);
            } else if (attrName === 'n-show' && directiveHandlers.handleNShow) {
                directiveHandlers.handleNShow(element, attrValue, scope, parentComponentName);
                attributesToRemoveAfterProcessing.push(attrName);
            } else if (attrName === 'n-html' && directiveHandlers.handleNHtml) {
                directiveHandlers.handleNHtml(element, attrValue, scope, parentComponentName);
                attributesToRemoveAfterProcessing.push(attrName);
            }
        }
        attributesToRemoveAfterProcessing.forEach(attrName => element.removeAttribute(attrName));
        
        // 1.5 递归处理子节点
        Array.from(element.childNodes).forEach(child => compileNode(child, scope, directiveHandlers, `${parentComponentName} > ${element.tagName}`));

    }
    // 2. 处理文本节点 (插值)
    else if (node.nodeType === Node.TEXT_NODE) {
        const textContent = node.textContent || '';
        const mustacheRegex = /\{\{([^}]+)\}\}/g; 
        if (!mustacheRegex.test(textContent)) return;

        const segments = []; 
        let lastIndex = 0;
        let match;
        mustacheRegex.lastIndex = 0; 
        while ((match = mustacheRegex.exec(textContent)) !== null) {
            if (match.index > lastIndex) segments.push(document.createTextNode(textContent.substring(lastIndex, match.index)));
            const expression = match[1].trim();
            const placeholderNode = document.createTextNode(''); 
            segments.push(placeholderNode);
            createEffect(() => {
                try {
                    const value = directiveHandlers.evaluateExpression(expression, scope);
                    placeholderNode.textContent = (value === undefined || value === null) ? '' : String(value);
                } catch (error) {
                    console.error(`核心错误：[${parentComponentName}] 计算插值表达式 "{{${expression}}}" 出错:`, error);
                    placeholderNode.textContent = `{{表达式错误: ${expression}}}`; 
                }
            });
            lastIndex = mustacheRegex.lastIndex; 
        }
        if (lastIndex < textContent.length) segments.push(document.createTextNode(textContent.substring(lastIndex)));
        if (segments.length > 0 && node.parentNode) {
            segments.forEach(segment => node.parentNode.insertBefore(segment, node));
            node.parentNode.removeChild(node); 
        }
    }
}

/**
 * 将 CSS 样式注入到文档头部。
 * @param {string} css CSS 字符串
 * @param {string} componentUrl 用于生成唯一 ID，防止重复注入
 */
function injectStyles(css, componentUrl) {
    if (!css || !css.trim()) return;
    const styleId = `nono-style-${componentUrl.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
    if (document.getElementById(styleId)) return; // 防止重复注入
    // console.log(`核心：注入样式 ${styleId}...`);
    const styleElement = document.createElement('style');
    styleElement.id = styleId;
    styleElement.textContent = css;
    document.head.appendChild(styleElement);
}

/**
 * 清理节点及其子孙节点（执行 onUnmount 钩子），然后从 DOM 中移除该节点。
 * @param {Node} node - 要清理和移除的 DOM 节点。
 */
function cleanupAndRemoveNode(node) {
    if (!node) return;
    if (node.nodeType === Node.ELEMENT_NODE) { // 只对元素节点操作
        // 递归清理子孙节点
        if (node.hasChildNodes()) {
            Array.from(node.childNodes).forEach(child => cleanupAndRemoveNode(child));
        }
        // 执行当前节点的 onUnmount (如果已注册)
        const cleanupCallback = componentCleanupRegistry.get(node);
        if (typeof cleanupCallback === 'function') {
            try {
                // console.log(`核心：调用组件 ${node.tagName.toLowerCase()} 的 onUnmount 钩子...`);
                cleanupCallback();
            } catch (error) {
                console.error(`核心错误：执行 onUnmount 钩子时出错 (元素: ${node.tagName}):`, error);
            }
            componentCleanupRegistry.delete(node); // 移除回调，防止重复执行
        }
    }
    // 从 DOM 中移除节点 (确保它还有父节点)
    if (node.parentNode) {
        node.parentNode.removeChild(node);
    }
}

/**
 * 挂载组件到目标位置。
 * @param {string} componentUrl .nue 文件的 URL
 * @param {string | Element | Comment} target - CSS 选择器、目标元素或占位符注释节点
 * @param {object} [initialProps={}] - 传递给组件的 Props
 * @param {object} [eventHandlers={}] - 父组件提供的事件处理器
 * @param {string} [componentName='组件'] - 组件名称，用于日志
 * @param {object} [parsedSlots={}] - 父组件解析并编译好的插槽内容
 * @returns {Promise<Element | null>} 返回挂载的组件根元素，或在失败时返回 null
 */
async function mountComponent(componentUrl, target, initialProps = {}, eventHandlers = {}, componentName = '组件', parsedSlots = {}) {
    console.log(`核心：开始挂载组件: ${componentName} (${componentUrl})`);
    let targetElement = null;
    let isPlaceholder = false;

    // 解析挂载目标
    if (typeof target === 'string') {
        targetElement = document.querySelector(target);
        if (!targetElement) {
            console.error(`核心错误：挂载失败，找不到目标元素 "${target}"`);
            return null;
        }
    } else if (target instanceof Element || target instanceof Comment) {
        targetElement = target;
        isPlaceholder = target instanceof Comment;
        if (isPlaceholder && !targetElement.parentNode) {
             console.error(`核心错误：挂载失败，注释占位符已脱离 DOM`);
             return null;
        }
    } else {
         console.error(`核心错误：挂载失败，无效的目标类型`, target);
         return null;
    }

    // 检查依赖
    if (typeof window.acorn === 'undefined') {
        console.error("核心错误：Acorn 解析器 (acorn.js) 未加载！");
        if (targetElement instanceof Element && !isPlaceholder) targetElement.innerHTML = `<p style="color: red;">错误：acorn.js 未加载</p>`;
        return null;
    }
    if (typeof window.NueDirectives === 'undefined' || typeof window.NueDirectives.evaluateExpression !== 'function') {
         console.error("核心错误：指令处理器 (nono-directives.js) 或其 evaluateExpression 未加载！");
         if (targetElement instanceof Element && !isPlaceholder) targetElement.innerHTML = `<p style="color: red;">错误：nono-directives.js 未加载</p>`;
         return null;
    }

    try {
        // 加载组件文件 (带缓存)
        let componentText;
        let cacheEntry = componentCache.get(componentUrl);
        if (cacheEntry && cacheEntry.text) {
            componentText = cacheEntry.text;
        } else {
            // console.log(`核心：正在网络加载 ${componentUrl}...`);
            const response = await fetch(componentUrl);
            if (!response.ok) throw new Error(`加载组件 ${componentUrl} 失败: ${response.status} ${response.statusText}`);
            componentText = await response.text();
            cacheEntry = componentCache.get(componentUrl) || { text: componentText }; // 获取或创建
            cacheEntry.text = componentText;
            componentCache.set(componentUrl, cacheEntry);
        }

        // 解析组件结构 (带缓存)
        if (!cacheEntry.structure) cacheEntry.structure = parseComponentStructure(componentText);
        const { template, script, style } = cacheEntry.structure;

        // 解析脚本 AST (带缓存)
        if (script.trim() && !cacheEntry.ast) cacheEntry.ast = parseScriptWithAcorn(script);
        const ast = cacheEntry.ast;

        // 创建 emit 函数并执行脚本获取作用域
        const emit = createEmitFunction(eventHandlers, componentName);
        const componentScope = executeScript(script, ast, initialProps, emit);
        if (componentScope && typeof componentScope === 'object') {
            componentScope.$slots = parsedSlots; // 注入插槽内容
        } else {
            console.warn(`核心警告：组件 ${componentName} 的脚本未返回有效作用域，无法注入 $slots。`);
        }

        // 编译模板
        // console.log(`核心：开始编译 ${componentName} 的模板...`);
        const fragment = document.createDocumentFragment();
        const tempDiv = document.createElement('div'); // 使用临时 div 解析模板字符串
        tempDiv.innerHTML = template.trim(); // trim() 避免首尾空白文本节点
        while (tempDiv.firstChild) fragment.appendChild(tempDiv.firstChild);
        
        const potentialRootElementInFragment = fragment.firstElementChild; // 记录可能的根元素

        Array.from(fragment.childNodes).forEach(node => compileNode(node, componentScope, window.NueDirectives, componentName));
        // console.log(`核心：${componentName} 模板编译完成.`);

        // 注入样式
        injectStyles(style, componentUrl);

        // 挂载到 DOM
        let mountedRootElement = null;
        if (isPlaceholder) { // 替换占位符注释
            const parent = targetElement.parentNode;
            if (parent) {
                parent.insertBefore(fragment, targetElement);
                mountedRootElement = potentialRootElementInFragment;
                parent.removeChild(targetElement); 
            }
        } else { // 替换目标元素内容
            cleanupAndRemoveNode(targetElement.firstChild); // 清理旧内容
            targetElement.innerHTML = ''; // 确保清空
            mountedRootElement = fragment.firstElementChild; 
            targetElement.appendChild(fragment);
        }
        
        // 执行 onMount 生命周期钩子
        if (mountedRootElement && componentScope && typeof componentScope.onMount === 'function') {
            try {
                // console.log(`核心：调用组件 ${componentName} 的 onMount 钩子...`);
                componentScope.onMount();
            } catch (error) {
                console.error(`核心错误：执行 onMount 钩子时出错 (${componentName}):`, error);
            }
            // 注册 onUnmount (如果存在)
            if (typeof componentScope.onUnmount === 'function') {
                componentCleanupRegistry.set(mountedRootElement, componentScope.onUnmount);
            }
        }
        
        console.log(`核心：组件 ${componentName} 挂载完成.`);
        return mountedRootElement;

    } catch (error) {
        console.error(`核心错误：挂载组件 ${componentUrl} 失败:`, error);
        if (targetElement instanceof Element && !isPlaceholder) {
            targetElement.innerHTML = `<p style="color:red;">组件 ${componentName} 加载或渲染失败。详情见控制台。</p>`;
        } else if (isPlaceholder && targetElement.parentNode) {
            const errorNode = document.createTextNode(` [组件 ${componentName} 渲染错误] `);
            targetElement.parentNode.insertBefore(errorNode, targetElement.nextSibling);
        }
        return null;
    }
}

// ==================================
// 4. 暴露核心 API
// ==================================
window.NueCore = {
    mountComponent,
    createSignal,
    createEffect,
    compileNode,    // 暴露给指令（如 n-if, n-for）进行递归编译
    cleanupAndRemoveNode, // (可选) 如果外部需要手动清理
};

console.log("nono-core.js 加载完成，NueCore 对象已准备就绪。");
