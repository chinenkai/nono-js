// nono-core.js - 优化版本
// 核心配置文件
const NueCoreConfig = {
    appVersion: null,
};

// Signal 核心实现
let currentEffect = null;

function createSignal(initialValue) {
    let value = initialValue;
    const subscribers = new Set();

    function signalAccessor(newValue) {
        if (arguments.length === 0) {
            if (currentEffect) {
                subscribers.add(currentEffect);
            }
            return value;
        } else {
            if (value !== newValue) {
                value = newValue;
                [...subscribers].forEach((effect) => effect());
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
    effect();
}

// 组件相关缓存与注册表
const componentCache = new Map();
const _pendingRequests = new Map();
const componentCleanupRegistry = new WeakMap();

// 辅助函数
const LOCAL_STORAGE_PREFIX = "nue_component_cache_";

function getComponentFromLocalStorage(versionedUrl) {
    if (!NueCoreConfig.appVersion) {
        return null;
    }
    const cacheKey = LOCAL_STORAGE_PREFIX + versionedUrl;
    try {
        const cachedItem = localStorage.getItem(cacheKey);
        if (cachedItem) {
            const { text, version } = JSON.parse(cachedItem);
            if (version === NueCoreConfig.appVersion && typeof text === "string") {
                return text;
            } else {
                localStorage.removeItem(cacheKey);
                return null;
            }
        }
    } catch (e) {
        console.warn(`核心警告：从 localStorage 读取组件 ${versionedUrl} 失败:`, e);
        try {
            localStorage.removeItem(cacheKey);
        } catch (removeError) {}
        return null;
    }
    return null;
}

function setComponentToLocalStorage(versionedUrl, text) {
    if (!NueCoreConfig.appVersion) {
        return;
    }
    const cacheKey = LOCAL_STORAGE_PREFIX + versionedUrl;
    const itemToStore = JSON.stringify({
        text: text,
        version: NueCoreConfig.appVersion,
    });
    try {
        localStorage.setItem(cacheKey, itemToStore);
    } catch (e) {
        console.warn(`核心警告：存入 localStorage 组件 ${versionedUrl} 失败 (可能已满):`, e);
    }
}

function cleanupOldLocalStorageCache() {
    if (!NueCoreConfig.appVersion) return;

    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith(LOCAL_STORAGE_PREFIX)) {
                try {
                    const item = localStorage.getItem(key);
                    if (item) {
                        const { version } = JSON.parse(item);
                        if (version !== NueCoreConfig.appVersion) {
                            localStorage.removeItem(key);
                            i--;
                        }
                    }
                } catch (e) {
                    localStorage.removeItem(key);
                    i--;
                }
            }
        }
    } catch (e) {
        console.warn("核心警告：清理旧 localStorage 缓存时出错:", e);
    }
}

function resolveUrl(relativeOrAbsoluteUrl, baseComponentUrl) {
    if (/^(?:[a-z]+:)?\/\//i.test(relativeOrAbsoluteUrl) || relativeOrAbsoluteUrl.startsWith("/")) {
        if (relativeOrAbsoluteUrl.startsWith("/") && !relativeOrAbsoluteUrl.startsWith("//")) {
            return new URL(relativeOrAbsoluteUrl, window.location.origin).href;
        }
        return new URL(relativeOrAbsoluteUrl, window.location.origin).href;
    }
    try {
        const base = baseComponentUrl ? new URL(baseComponentUrl, window.location.origin) : new URL(window.location.href);
        return new URL(relativeOrAbsoluteUrl, base).href;
    } catch (e) {
        console.warn(`核心警告：解析 URL "${relativeOrAbsoluteUrl}" (基准: "${baseComponentUrl || window.location.href}") 失败，将按原样使用。错误:`, e);
        return relativeOrAbsoluteUrl;
    }
}

function getVersionedAndOriginalUrls(rawUrl, baseComponentUrlForResolution) {
    const originalAbsoluteUrl = resolveUrl(rawUrl, baseComponentUrlForResolution);
    let versionedUrl = originalAbsoluteUrl;
    if (NueCoreConfig.appVersion) {
        try {
            const urlObj = new URL(originalAbsoluteUrl);
            urlObj.searchParams.set("v", NueCoreConfig.appVersion);
            versionedUrl = urlObj.href;
        } catch (e) {
            console.warn(`核心警告：为 URL "${originalAbsoluteUrl}" 添加版本号失败，将使用原始URL。错误:`, e);
        }
    }
    return { versionedUrl, originalUrl: originalAbsoluteUrl };
}

// 组件处理核心函数
function parseComponentStructure(text, versionedUrl) {
    const cached = componentCache.get(versionedUrl);
    if (cached && cached.structure) {
        return cached.structure;
    }

    let template = "";
    let script = "";
    let style = "";

    const firstTemplateStartTag = text.indexOf("<template");
    if (firstTemplateStartTag !== -1) {
        const firstTemplateStartTagEnd = text.indexOf(">", firstTemplateStartTag);
        if (firstTemplateStartTagEnd !== -1) {
            const lastTemplateEndTag = text.lastIndexOf("</template>");
            if (lastTemplateEndTag !== -1 && lastTemplateEndTag > firstTemplateStartTagEnd) {
                template = text.substring(firstTemplateStartTagEnd + 1, lastTemplateEndTag).trim();
            } else {
                const templateMatchFallback = text.match(/<template\b[^>]*>([\s\S]*?)<\/template\s*>/i);
                template = templateMatchFallback ? templateMatchFallback[1].trim() : "";
            }
        }
    }

    const scriptMatch = text.match(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/i);
    script = scriptMatch ? scriptMatch[1].trim() : "";

    const styleMatch = text.match(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/i);
    style = styleMatch ? styleMatch[1].trim() : "";

    const structure = { template, script, style };

    if (cached) {
        cached.structure = structure;
    }
    return structure;
}

function parseScriptWithAcorn(scriptContent, versionedUrl) {
    const cached = componentCache.get(versionedUrl);
    if (cached && cached.ast) {
        return cached.ast;
    }
    if (!window.acorn) {
        console.error("核心错误：Acorn 解析器 (acorn.js) 未加载！");
        return null;
    }
    try {
        const ast = acorn.parse(scriptContent, {
            ecmaVersion: 2020,
            sourceType: "module",
            allowReturnOutsideFunction: true,
        });
        if (cached) {
            cached.ast = ast;
        }
        return ast;
    } catch (error) {
        console.error("核心错误：Acorn 解析脚本失败:", error);
        console.error("核心错误：问题脚本内容:\n", scriptContent);
        return null;
    }
}

function executeScript(scriptContent, ast, initialProps = {}, emit = () => console.warn("核心警告：emit 函数未在执行脚本时提供")) {
    if (!scriptContent.trim()) {
        return {};
    }
    if (ast === null && scriptContent.trim()) {
        console.warn("核心警告：由于脚本解析失败，跳过执行。返回空作用域。");
        return {};
    }
    try {
        const scriptFunction = new Function("createSignal", "props", "emit", scriptContent);
        const componentScope = scriptFunction(createSignal, initialProps, emit);

        if (typeof componentScope === "object" && componentScope !== null) {
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

function createEmitFunction(eventHandlers, componentName = "子组件") {
    return function emit(eventName, payload) {
        const handler = eventHandlers[eventName];
        if (handler && typeof handler === "function") {
            try {
                handler(payload);
            } catch (error) {
                console.error(`核心错误：执行 ${componentName} 的事件 "${eventName}" 处理器时出错:`, error);
            }
        }
    };
}

function kebabToCamel(kebabCase) {
    return kebabCase.replace(/-([a-z])/g, (match, letter) => letter.toUpperCase());
}

async function fetchAndCacheComponentText(versionedUrl, originalAbsoluteUrl) {
    const localStorageText = getComponentFromLocalStorage(versionedUrl);
    if (localStorageText !== null) {
        if (!componentCache.has(versionedUrl)) {
            componentCache.set(versionedUrl, { text: localStorageText, structure: null, ast: null, originalUrl: originalAbsoluteUrl });
        } else {
            componentCache.get(versionedUrl).text = localStorageText;
        }
        return localStorageText;
    }

    if (componentCache.has(versionedUrl)) {
        return componentCache.get(versionedUrl).text;
    }

    if (_pendingRequests.has(versionedUrl)) {
        return _pendingRequests.get(versionedUrl);
    }

    const fetchPromise = fetch(versionedUrl)
        .then((response) => {
            if (!response.ok) {
                throw new Error(`加载组件 ${versionedUrl} 失败: ${response.status} ${response.statusText}`);
            }
            return response.text();
        })
        .then((text) => {
            componentCache.set(versionedUrl, { text, structure: null, ast: null, originalUrl: originalAbsoluteUrl });
            setComponentToLocalStorage(versionedUrl, text);
            _pendingRequests.delete(versionedUrl);
            return text;
        })
        .catch((error) => {
            _pendingRequests.delete(versionedUrl);
            console.error(`核心错误：获取组件 ${versionedUrl} 文本失败:`, error);
            throw error;
        });

    _pendingRequests.set(versionedUrl, fetchPromise);
    return fetchPromise;
}

function compileNode(node, scope, directiveHandlers, parentComponentName = "根组件", currentContextOriginalUrl = null) {
    if (!directiveHandlers || typeof directiveHandlers.evaluateExpression !== "function") {
        console.error(`核心错误：[${parentComponentName}] 指令处理器或 evaluateExpression 未准备好，编译中止。`);
        return;
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node;
        const tagName = element.tagName.toLowerCase();

        if (tagName.includes("-") && !["template", "script", "style", "slot"].includes(tagName)) {
            const srcAttr = element.getAttribute("src");
            const rawComponentPath = srcAttr ? srcAttr : `${tagName}.nue`;
            const { versionedUrl: childVersionedUrl, originalUrl: childOriginalUrl } = getVersionedAndOriginalUrls(rawComponentPath, currentContextOriginalUrl);

            const initialProps = {};
            const eventHandlers = {};
            const attributesToRemove = [];

            for (const attr of Array.from(element.attributes)) {
                const attrName = attr.name;
                const attrValue = attr.value;

                if (attrName === "src") {
                    attributesToRemove.push(attrName);
                    continue;
                }

                if (attrName.startsWith(":")) {
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
                } else if (attrName.startsWith("@")) {
                    const eventName = attrName.substring(1);
                    const handlerExpression = attrValue;
                    eventHandlers[eventName] = (payload) => {
                        try {
                            const context = Object.create(scope);
                            context.$event = payload;
                            const result = directiveHandlers.evaluateExpression(handlerExpression, context);
                            if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(handlerExpression.trim()) && typeof result === "function") {
                                result.call(scope, payload);
                            }
                        } catch (error) {
                            console.error(`核心错误：[${parentComponentName}] 执行子组件事件处理器 "${handlerExpression}" 出错:`, error);
                        }
                    };
                    attributesToRemove.push(attrName);
                } else {
                    initialProps[kebabToCamel(attrName)] = attrValue;
                }
            }

            const parsedSlots = {};
            const slotContentContainer = document.createDocumentFragment();
            const tempChildNodes = Array.from(element.childNodes);
            tempChildNodes.forEach((cn) => slotContentContainer.appendChild(cn));

            const rawSlotContents = { default: [] };
            Array.from(slotContentContainer.childNodes).forEach((childNode) => {
                if (childNode.nodeType === Node.ELEMENT_NODE && childNode.tagName.toLowerCase() === "template") {
                    if (childNode.hasAttribute("slot")) {
                        let slotNameAttr = (childNode.getAttribute("slot") || "").trim();
                        if (!slotNameAttr) {
                            const templateContent = childNode.content;
                            if (templateContent) Array.from(templateContent.childNodes).forEach((c) => rawSlotContents.default.push(c.cloneNode(true)));
                        } else {
                            if (!rawSlotContents[slotNameAttr]) rawSlotContents[slotNameAttr] = [];
                            const templateContent = childNode.content;
                            if (templateContent) Array.from(templateContent.childNodes).forEach((c) => rawSlotContents[slotNameAttr].push(c.cloneNode(true)));
                        }
                    } else {
                        const templateContent = childNode.content;
                        if (templateContent) Array.from(templateContent.childNodes).forEach((c) => rawSlotContents.default.push(c.cloneNode(true)));
                    }
                } else if (!(childNode.nodeType === Node.TEXT_NODE && childNode.nodeValue.trim() === "")) {
                    rawSlotContents.default.push(childNode.cloneNode(true));
                }
            });

            for (const sName in rawSlotContents) {
                const compiledSlotFragment = document.createDocumentFragment();
                if (rawSlotContents[sName].length > 0) {
                    rawSlotContents[sName].forEach((n) => compiledSlotFragment.appendChild(n));
                    Array.from(compiledSlotFragment.childNodes).forEach((nodeToCompile) => {
                        compileNode(nodeToCompile, scope, directiveHandlers, `${parentComponentName} (slot '${sName}')`, currentContextOriginalUrl);
                    });
                }
                parsedSlots[sName] = compiledSlotFragment;
            }

            attributesToRemove.forEach((attrName) => element.removeAttribute(attrName));
            const placeholder = document.createComment(`component-placeholder: ${tagName}`);
            if (!element.parentNode) {
                console.error(`核心错误：[${parentComponentName}] 子组件 <${tagName}> 在替换为占位符前已无父节点。`);
                return;
            }
            element.parentNode.replaceChild(placeholder, element);

            mountComponent(
                childVersionedUrl,
                placeholder,
                initialProps,
                eventHandlers,
                tagName,
                parsedSlots,
                childOriginalUrl,
            ).catch((error) => console.error(`核心错误：[${parentComponentName}] 异步挂载子组件 <${tagName}> (${childVersionedUrl}) 失败:`, error));
            return;
        }

        const nIfAttr = element.getAttribute("n-if");
        if (nIfAttr !== null) {
            directiveHandlers.handleNIf(element, nIfAttr, scope, (node, s, dh, cn) => compileNode(node, s, dh, cn, currentContextOriginalUrl), directiveHandlers, parentComponentName);
            return;
        }
        const nForAttr = element.getAttribute("n-for");
        if (nForAttr !== null) {
            directiveHandlers.handleNFor(element, nForAttr, scope, (node, s, dh, cn) => compileNode(node, s, dh, cn, currentContextOriginalUrl), directiveHandlers, parentComponentName);
            return;
        }

        if (tagName === "slot") {
            const slotName = element.getAttribute("name") || "default";
            const providedContentFragment = scope.$slots && scope.$slots[slotName];
            const parentOfSlot = element.parentNode;

            if (parentOfSlot) {
                if (providedContentFragment && providedContentFragment.childNodes.length > 0) {
                    parentOfSlot.insertBefore(providedContentFragment.cloneNode(true), element);
                } else {
                    const fallbackFragment = document.createDocumentFragment();
                    while (element.firstChild) fallbackFragment.appendChild(element.firstChild);
                    Array.from(fallbackFragment.childNodes).forEach((fallbackNode) => {
                        compileNode(fallbackNode, scope, directiveHandlers, `${parentComponentName} (slot '${slotName}' fallback)`, currentContextOriginalUrl);
                    });
                    parentOfSlot.insertBefore(fallbackFragment, element);
                }
                parentOfSlot.removeChild(element);
            } else {
                console.warn(`核心警告：[${parentComponentName}] <slot name="${slotName}"> 标签无父节点，无法渲染。`);
            }
            return;
        }

        const attributesToRemoveAfterProcessing = [];
        for (const attr of Array.from(element.attributes)) {
            const attrName = attr.name;
            const attrValue = attr.value;
            if (attrName.startsWith(":")) {
                if (directiveHandlers.handleAttributeBinding) directiveHandlers.handleAttributeBinding(element, attrName.substring(1), attrValue, scope, parentComponentName);
                attributesToRemoveAfterProcessing.push(attrName);
            } else if (attrName.startsWith("@")) {
                const eventName = attrName.substring(1);
                element.addEventListener(eventName, (event) => {
                    try {
                        const context = Object.create(scope);
                        context.$event = event;
                        const result = directiveHandlers.evaluateExpression(attrValue, context);
                        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(attrValue.trim()) && typeof result === "function") {
                            result.call(scope, event);
                        }
                    } catch (error) {
                        console.error(`核心错误：[${parentComponentName}] 执行事件处理器 "${attrValue}" 出错:`, error);
                    }
                });
                attributesToRemoveAfterProcessing.push(attrName);
            } else if (attrName === "n-model" && directiveHandlers.handleNModel) {
                directiveHandlers.handleNModel(element, attrValue, scope, parentComponentName);
                attributesToRemoveAfterProcessing.push(attrName);
            } else if (attrName === "n-show" && directiveHandlers.handleNShow) {
                directiveHandlers.handleNShow(element, attrValue, scope, parentComponentName);
                attributesToRemoveAfterProcessing.push(attrName);
            } else if (attrName === "n-html" && directiveHandlers.handleNHtml) {
                directiveHandlers.handleNHtml(element, attrValue, scope, parentComponentName);
                attributesToRemoveAfterProcessing.push(attrName);
            }
        }
        attributesToRemoveAfterProcessing.forEach((attrName) => element.removeAttribute(attrName));

        Array.from(element.childNodes).forEach((child) => compileNode(child, scope, directiveHandlers, `${parentComponentName} > ${element.tagName.toUpperCase()}`, currentContextOriginalUrl));
    }
    else if (node.nodeType === Node.TEXT_NODE) {
        const textContent = node.textContent || "";
        const mustacheRegex = /\{\{([^}]+)\}\}/g;
        if (!mustacheRegex.test(textContent)) return;

        const segments = [];
        let lastIndex = 0;
        let match;
        mustacheRegex.lastIndex = 0;
        while ((match = mustacheRegex.exec(textContent)) !== null) {
            if (match.index > lastIndex) segments.push(document.createTextNode(textContent.substring(lastIndex, match.index)));

            const expression = match[1].trim();
            const placeholderNode = document.createTextNode("");
            segments.push(placeholderNode);

            createEffect(() => {
                try {
                    const value = directiveHandlers.evaluateExpression(expression, scope);
                    placeholderNode.textContent = value === undefined || value === null ? "" : String(value);
                } catch (error) {
                    console.error(`核心错误：[${parentComponentName}] 计算插值表达式 "{{${expression}}}" 出错:`, error);
                    placeholderNode.textContent = `{{表达式错误: ${expression}}}`;
                }
            });
            lastIndex = mustacheRegex.lastIndex;
        }
        if (lastIndex < textContent.length) segments.push(document.createTextNode(textContent.substring(lastIndex)));

        if (segments.length > 0 && node.parentNode) {
            segments.forEach((segment) => node.parentNode.insertBefore(segment, node));
            node.parentNode.removeChild(node);
        }
    }
}

function injectStyles(css, originalComponentUrl) {
    if (!css || !css.trim()) return;
    const styleId = `nono-style-${originalComponentUrl.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    if (document.getElementById(styleId)) return;

    const styleElement = document.createElement("style");
    styleElement.id = styleId;
    styleElement.textContent = css;
    document.head.appendChild(styleElement);
}

function cleanupAndRemoveNode(node) {
    if (!node) return;
    if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.hasChildNodes()) {
            Array.from(node.childNodes).forEach((child) => cleanupAndRemoveNode(child));
        }
        const cleanupCallback = componentCleanupRegistry.get(node);
        if (typeof cleanupCallback === "function") {
            try {
                cleanupCallback();
            } catch (error) {
                console.error(`核心错误：执行 onUnmount 钩子时出错 (元素: ${node.tagName}):`, error);
            }
            componentCleanupRegistry.delete(node);
        }
    }
    if (node.parentNode) {
        node.parentNode.removeChild(node);
    }
}

async function _mountComponentInternal(versionedComponentUrl, target, initialProps = {}, eventHandlers = {}, componentName = "组件", parsedSlots = {}, originalAbsoluteUrl) {
    let targetElement = null;
    let isPlaceholder = false;

    if (typeof target === "string") {
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

    if (typeof window.acorn === "undefined") {
        console.error("核心错误：Acorn 解析器 (acorn.js) 未加载！");
        if (targetElement instanceof Element && !isPlaceholder) targetElement.innerHTML = `<p style="color: red;">错误：acorn.js 未加载</p>`;
        return null;
    }
    if (typeof window.NueDirectives === "undefined" || typeof window.NueDirectives.evaluateExpression !== "function") {
        console.error("核心错误：指令处理器 (nono-directives.js) 或其 evaluateExpression 未加载！");
        if (targetElement instanceof Element && !isPlaceholder) targetElement.innerHTML = `<p style="color: red;">错误：nono-directives.js 未加载</p>`;
        return null;
    }

    try {
        const componentText = await fetchAndCacheComponentText(versionedComponentUrl, originalAbsoluteUrl);
        let cacheEntry = componentCache.get(versionedComponentUrl);
        if (!cacheEntry) {
            console.error(`核心严重错误：组件 ${versionedComponentUrl} 文本已获取，但缓存条目丢失！将尝试重新创建。`);
            cacheEntry = { text: componentText, structure: null, ast: null, originalUrl: originalAbsoluteUrl };
            componentCache.set(versionedComponentUrl, cacheEntry);
        }

        if (!cacheEntry.structure) {
            cacheEntry.structure = parseComponentStructure(componentText, versionedComponentUrl);
        }
        const { template, script, style } = cacheEntry.structure;

        if (script.trim() && !cacheEntry.ast) {
            cacheEntry.ast = parseScriptWithAcorn(script, versionedComponentUrl);
        }
        const ast = cacheEntry.ast;

        const emit = createEmitFunction(eventHandlers, componentName);
        const componentScope = executeScript(script, ast, initialProps, emit);
        if (componentScope && typeof componentScope === "object") {
            componentScope.$slots = parsedSlots;
        } else {
            console.warn(`核心警告：组件 ${componentName} 的脚本未返回有效作用域，无法注入 $slots。`);
        }

        const fragment = document.createDocumentFragment();
        const tempDiv = document.createElement("div");
        tempDiv.innerHTML = template.trim();
        while (tempDiv.firstChild) fragment.appendChild(tempDiv.firstChild);

        const potentialRootElementInFragment = fragment.firstElementChild;
        Array.from(fragment.childNodes).forEach((node) => compileNode(node, componentScope, window.NueDirectives, componentName, originalAbsoluteUrl));
        injectStyles(style, originalAbsoluteUrl);

        let mountedRootElement = null;
        if (isPlaceholder) {
            const parent = targetElement.parentNode;
            if (parent) {
                parent.insertBefore(fragment, targetElement);
                mountedRootElement = potentialRootElementInFragment;
                parent.removeChild(targetElement);
            }
        } else {
            cleanupAndRemoveNode(targetElement.firstChild);
            targetElement.innerHTML = "";
            mountedRootElement = fragment.firstElementChild;
            targetElement.appendChild(fragment);
        }

        if (mountedRootElement && componentScope && typeof componentScope.onMount === "function") {
            try {
                componentScope.onMount();
            } catch (error) {
                console.error(`核心错误：执行 onMount 钩子时出错 (${componentName}):`, error);
            }
            if (typeof componentScope.onUnmount === "function") {
                componentCleanupRegistry.set(mountedRootElement, componentScope.onUnmount);
            }
        }
        return mountedRootElement;
    } catch (error) {
        console.error(`核心错误：挂载组件 ${versionedComponentUrl} (源: ${originalAbsoluteUrl}) 失败:`, error);
        if (targetElement instanceof Element && !isPlaceholder) {
            targetElement.innerHTML = `<p style="color:red;">组件 ${componentName} 加载或渲染失败。详情见控制台。</p>`;
        } else if (isPlaceholder && targetElement.parentNode) {
            const errorNode = document.createTextNode(` [组件 ${componentName} (源: ${originalAbsoluteUrl}) 渲染错误] `);
            targetElement.parentNode.insertBefore(errorNode, targetElement.nextSibling);
        }
        return null;
    }
}

function mountComponent(
    componentFile,
    targetSelectorOrElement,
    initialProps = {},
    eventHandlers = {},
    componentNameSuggestion,
    parsedSlots = {},
    baseResolutionUrlOverride,
) {
    const { versionedUrl, originalUrl } = getVersionedAndOriginalUrls(componentFile, baseResolutionUrlOverride || null);
    let finalComponentName = componentNameSuggestion;
    if (!finalComponentName) {
        const nameParts = originalUrl.substring(originalUrl.lastIndexOf("/") + 1).split(".");
        finalComponentName = nameParts[0] || "组件";
    }
    return _mountComponentInternal(
        versionedUrl,
        targetSelectorOrElement,
        initialProps,
        eventHandlers,
        finalComponentName,
        parsedSlots,
        originalUrl,
    );
}

// 暴露核心 API
window.NueCore = {
    init: function (targetId, rootComponentFile, appVersion, initialProps = {}) {
        if (typeof targetId !== "string" || !targetId.trim()) {
            console.error("核心错误：NueCore.init() 的第一个参数 targetId 必须是一个有效的非空字符串 (DOM 元素 ID)。");
            return Promise.resolve(null);
        }
        if (typeof rootComponentFile !== "string" || !rootComponentFile.trim()) {
            console.error("核心错误：NueCore.init() 的第二个参数 rootComponentFile 必须是一个有效的非空字符串 (组件路径)。");
            return Promise.resolve(null);
        }

        if (appVersion && typeof appVersion === "string" && appVersion.trim()) {
            NueCoreConfig.appVersion = appVersion.trim();
        } else {
            NueCoreConfig.appVersion = null;
            if (appVersion !== undefined) {
                console.warn(`核心警告：提供的应用版本号无效，组件将不带版本参数加载。`);
            }
        }

        if (NueCoreConfig.appVersion) {
            cleanupOldLocalStorageCache();
        }

        const targetSelector = `#${targetId}`;
        return mountComponent(rootComponentFile, targetSelector, initialProps);
    },
    createSignal,
    createEffect,
    compileNode,
    cleanupAndRemoveNode,
};
