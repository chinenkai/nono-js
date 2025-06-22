// nono-core.js - 最终修复版

// 核心配置文件
const NueCoreConfig = {
    appVersion: null,
};

const __NUE_CONFUSION_KEY__ = "NueJS-is-Awesome-And-Secret-!@#$%^";
function nueSimpleTransform(text, key) {
    if (!text || !key) return text;
    let result = "";
    try {
        for (let i = 0; i < text.length; i++) {
            result += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
        }
    } catch (e) {
        console.error("[NueCore] 文本转换时发生错误:", e, "将返回原始文本。");
        return text;
    }
    return result;
}

let currentEffect = null;
let _currentEffectCleanupList = null;
const componentEffectsRegistry = new WeakMap();

function createSignal(initialValue) {
    let value = initialValue;
    const subscribers = new Set();
    function signalAccessor(newValue) {
        if (arguments.length === 0) {
            if (currentEffect && currentEffect.isActive) {
                subscribers.add(currentEffect);
                currentEffect.dependencies.add(subscribers);
            }
            return value;
        } else {
            if (value !== newValue) {
                value = newValue;
                const effectsToRun = new Set(subscribers);
                effectsToRun.forEach((effectInstance) => {
                    if (effectInstance && typeof effectInstance === "function" && effectInstance.isActive) {
                        effectInstance();
                    }
                });
            }
            return newValue;
        }
    }
    signalAccessor.__is_signal__ = true;
    return signalAccessor;
}

function createEffect(fn) {
    const effect = () => {
        if (!effect.isActive) return;
        cleanupEffectDependencies(effect);
        currentEffect = effect;
        effect.dependencies = new Set();
        try {
            fn();
        } catch (error) {
            console.error("Error executing effect:", error);
        } finally {
            currentEffect = null;
        }
    };
    effect.isActive = true;
    effect.dependencies = new Set();
    function cleanupEffectDependencies(effectInstance) {
        if (effectInstance.dependencies) {
            effectInstance.dependencies.forEach((signalSubscribersSet) => {
                signalSubscribersSet.delete(effectInstance);
            });
            effectInstance.dependencies.clear();
        }
    }
    const stopEffect = () => {
        if (effect.isActive) {
            cleanupEffectDependencies(effect);
            effect.isActive = false;
        }
    };
    if (_currentEffectCleanupList && Array.isArray(_currentEffectCleanupList)) {
        _currentEffectCleanupList.push(stopEffect);
    }
    try {
        effect();
    } catch (e) {
        console.error("Error during initial effect execution:", e);
    }
    return stopEffect;
}

if (typeof queueMicrotask !== "function") {
    window.queueMicrotask = function (cb) {
        Promise.resolve().then(cb);
    };
}

function createWatch(signalToWatch, callback, options = {}) {
    const { immediate = false } = options;
    let oldValue;
    let isInitialized = false;
    let pendingCallback = false;
    const scheduleCallback = (newValue, oldValueForCallback) => {
        if (pendingCallback) return;
        pendingCallback = true;
        queueMicrotask(() => {
            try {
                callback(newValue, oldValueForCallback);
            } catch (e) {
                console.error("Watch callback execution failed:", e);
            } finally {
                pendingCallback = false;
            }
        });
    };
    const stop = createEffect(() => {
        const newValue = signalToWatch();
        if (!isInitialized) {
            oldValue = newValue;
            isInitialized = true;
            if (immediate) {
                scheduleCallback(newValue, undefined);
            }
            return;
        }
        if (newValue !== oldValue) {
            const previousOldValue = oldValue;
            oldValue = newValue;
            scheduleCallback(newValue, previousOldValue);
        }
    });
    return stop;
}

// 路由功能 (无修改)
function _getCurrentLocationString() {
    return window.location.pathname + window.location.search + window.location.hash;
}
const _currentUrlSignal = createSignal(_getCurrentLocationString());
function _updateCurrentUrlSignal() {
    _currentUrlSignal(_getCurrentLocationString());
}
window.addEventListener("popstate", () => {
    _updateCurrentUrlSignal();
});
document.addEventListener("click", (event) => {
    const anchor = event.target.closest("a");
    if (anchor && anchor.href) {
        const targetUrl = new URL(anchor.href, window.location.origin);
        if (targetUrl.origin === window.location.origin && !anchor.target && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && anchor.getAttribute("download") === null) {
            const newLocationString = targetUrl.pathname + targetUrl.search + targetUrl.hash;
            if (_getCurrentLocationString() !== newLocationString) {
                event.preventDefault();
                history.pushState(null, "", anchor.href);
                _updateCurrentUrlSignal();
            } else if (anchor.href.includes("#") && targetUrl.pathname === window.location.pathname && targetUrl.search === window.location.search) {
                event.preventDefault();
                if (_getCurrentLocationString() !== newLocationString) {
                    history.pushState(null, "", anchor.href);
                    _updateCurrentUrlSignal();
                }
            }
        }
    }
});
function createUrlWatch(urlPattern, onMatch, onUnmatch) {
    let regex;
    if (urlPattern instanceof RegExp) {
        regex = urlPattern;
    } else if (typeof urlPattern === "string") {
        try {
            regex = new RegExp(urlPattern);
        } catch (e) {
            console.error(`[NueCore.createUrlWatch] 无效的正则表达式字符串: "${urlPattern}"`, e);
            return () => {};
        }
    } else {
        console.error("[NueCore.createUrlWatch] urlPattern 参数必须是字符串或 RegExp 对象。");
        return () => {};
    }
    let wasMatched = false;
    const stopWatchingSignal = createWatch(
        _currentUrlSignal,
        (newUrlString) => {
            const isNowMatched = regex.test(newUrlString);
            if (isNowMatched && !wasMatched) {
                if (typeof onMatch === "function") {
                    try {
                        onMatch(newUrlString);
                    } catch (e) {
                        console.error("[NueCore.createUrlWatch] onMatch 回调执行出错:", e);
                    }
                }
            } else if (!isNowMatched && wasMatched) {
                if (typeof onUnmatch === "function") {
                    try {
                        onUnmatch(newUrlString);
                    } catch (e) {
                        console.error("[NueCore.createUrlWatch] onUnmatch 回调执行出错:", e);
                    }
                }
            }
            wasMatched = isNowMatched;
        },
        { immediate: true },
    );
    return stopWatchingSignal;
}
function navigateTo(path, state = null, title = "") {
    const newLocationString = new URL(path, window.location.origin).pathname + new URL(path, window.location.origin).search + new URL(path, window.location.origin).hash;
    if (_getCurrentLocationString() !== newLocationString) {
        history.pushState(state, title, path);
        _updateCurrentUrlSignal();
    }
}

// 组件及模块相关缓存与注册表
const componentCache = new Map();
const _pendingRequests = new Map();
const componentCleanupRegistry = new WeakMap();
const njsModuleExecutionCache = new Map();
const _pendingNjsModuleLoads = new Map();

// 辅助函数 (无修改)
function resolveUrl(relativeOrAbsoluteUrl, baseComponentUrl) {
    if (/^(?:[a-z]+:)?\/\//i.test(relativeOrAbsoluteUrl)) {
        return new URL(relativeOrAbsoluteUrl, window.location.origin).href;
    }
    if (relativeOrAbsoluteUrl.startsWith("/")) {
        if (!relativeOrAbsoluteUrl.startsWith("//")) {
            return new URL(relativeOrAbsoluteUrl, window.location.origin).href;
        }
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
async function _executeNjsScript(scriptContent, njsVersionedUrl, njsOriginalUrl) {
    if (!scriptContent.trim()) {
        console.warn(`核心警告：NJS 脚本 ${njsOriginalUrl} 内容为空，将返回 Promise<undefined>。`);
        return undefined;
    }
    try {
        const boundImportNjs = (relativePath) => {
            return _loadAndExecuteNjsModule(relativePath, njsOriginalUrl);
        };
        let dynamicNjsName;
        try {
            const urlObj = new URL(njsOriginalUrl);
            dynamicNjsName = `${urlObj.pathname}.temp.js`;
        } catch (e) {
            dynamicNjsName = `${njsOriginalUrl.replace(/[?#].*$/, "")}.temp.js`;
        }
        dynamicNjsName = encodeURI(dynamicNjsName);
        const njsFunction = new Function("importNjs", `return (async () => { \n${scriptContent}\n })(); \n//# sourceURL=${dynamicNjsName}`);
        const resultPromise = njsFunction(boundImportNjs);
        return await resultPromise;
    } catch (error) {
        throw error;
    }
}
async function _loadAndExecuteNjsModule(relativePath, baseOriginalUrl) {
    const { versionedUrl, originalUrl } = getVersionedAndOriginalUrls(relativePath, baseOriginalUrl);
    if (njsModuleExecutionCache.has(versionedUrl)) {
        return njsModuleExecutionCache.get(versionedUrl);
    }
    if (_pendingNjsModuleLoads.has(versionedUrl)) {
        return _pendingNjsModuleLoads.get(versionedUrl);
    }
    const loadPromise = (async () => {
        try {
            const scriptText = await fetchAndCacheComponentText(versionedUrl, originalUrl);
            const executionResultPromise = _executeNjsScript(scriptText, versionedUrl, originalUrl);
            const finalModuleData = await executionResultPromise;
            njsModuleExecutionCache.set(versionedUrl, finalModuleData);
            return finalModuleData;
        } catch (error) {
            console.error(`核心错误：NJS 模块 ${originalUrl} 的加载或执行流程失败。`);
            throw error;
        }
    })();
    _pendingNjsModuleLoads.set(versionedUrl, loadPromise);
    loadPromise.finally(() => {
        _pendingNjsModuleLoads.delete(versionedUrl);
    });
    return loadPromise;
}
function kebabToCamel(kebabCase) {
    return kebabCase.replace(/-([a-z])/g, (match, letter) => letter.toUpperCase());
}
// [REPLACE] 步骤 3.1: 用这个版本替换旧的 fetchAndCacheComponentText
async function fetchAndCacheComponentText(versionedUrl, originalAbsoluteUrl) {
    if (window.__NUE_PRELOADED_DATA__ && typeof window.__NUE_PRELOADED_DATA__ === "object" && window.__NUE_PRELOADED_DATA__.hasOwnProperty(originalAbsoluteUrl)) {
        const confusedTextFromBundle = window.__NUE_PRELOADED_DATA__[originalAbsoluteUrl];
        const preloadedText = nueSimpleTransform(confusedTextFromBundle, __NUE_CONFUSION_KEY__);
        if (!componentCache.has(versionedUrl)) {
            // [MODIFIED] 增加 templateElement: null 字段
            componentCache.set(versionedUrl, { text: preloadedText, structure: null, templateElement: null, originalUrl: originalAbsoluteUrl });
        } else {
            const cachedEntry = componentCache.get(versionedUrl);
            cachedEntry.text = preloadedText;
            cachedEntry.originalUrl = originalAbsoluteUrl;
        }
        return Promise.resolve(preloadedText);
    }
    const memoryCached = componentCache.get(versionedUrl);
    if (memoryCached && typeof memoryCached.text === "string") {
        return memoryCached.text;
    }
    if (_pendingRequests.has(versionedUrl)) {
        return _pendingRequests.get(versionedUrl);
    }
    const fetchPromise = fetch(versionedUrl)
        .then((response) => {
            if (!response.ok) {
                throw new Error(`加载资源 ${versionedUrl} (原始: ${originalAbsoluteUrl}) 失败: ${response.status} ${response.statusText}`);
            }
            return response.text();
        })
        .then((text) => {
            // [MODIFIED] 增加 templateElement: null 字段
            componentCache.set(versionedUrl, { text, structure: null, templateElement: null, originalUrl: originalAbsoluteUrl });
            _pendingRequests.delete(versionedUrl);
            return text;
        })
        .catch((error) => {
            _pendingRequests.delete(versionedUrl);
            console.error(`核心错误：获取资源 ${versionedUrl} (原始: ${originalAbsoluteUrl}) 文本失败:`, error);
            throw error;
        });
    _pendingRequests.set(versionedUrl, fetchPromise);
    return fetchPromise;
}

const propTypeConverters = {
    String: (val) => String(val),
    Number: (val) => {
        const num = Number(val);
        return isNaN(num) ? undefined : num;
    },
    Boolean: (val) => {
        if (val === "true" || val === "") return true;
        if (val === "false") return false;
        return Boolean(val);
    },
    Object: (val) => {
        try {
            return JSON.parse(val);
        } catch (e) {
            console.warn(`Prop类型转换警告：无法将字符串 "${val}" 解析为 Object。`, e);
            return undefined;
        }
    },
    Array: (val) => {
        try {
            const parsed = JSON.parse(val);
            return Array.isArray(parsed) ? parsed : undefined;
        } catch (e) {
            console.warn(`Prop类型转换警告：无法将字符串 "${val}" 解析为 Array。`, e);
            return undefined;
        }
    },
};

// ===================================================================
// 【核心重构】统一的属性和事件处理
// ===================================================================

// nono-core.js

/**
 * 【已重构】统一的 Props 和 Events 解析与处理函数。
 * 此函数取代了旧的 processComponentProps 和 parseComponentProps。
 * @param {Element} element - 组件的 DOM 元素。
 * @param {object} scope - 父组件的作用域。
 * @param {object} propSchema - 组件定义的 Prop 模式 (可选)。
 * @param {string} componentName - 组件的名称，用于日志。
 * @returns {{ props: object, events: object, attributesToRemove: string[] }}
 */
function parseAndProcessProps(element, scope, propSchema = {}, componentName) {
    const rawProps = { static: {}, dynamic: {} };
    const events = {};
    const attributesToRemove = [];
    const providedPropNames = new Set();

    // 步骤 1: 从元素上提取所有属性和事件
    for (const attr of Array.from(element.attributes)) {
        const attrName = attr.name;
        const attrValue = attr.value;
        let camelCasePropName;

        if (attrName.startsWith(":")) {
            const rawPropName = attrName.substring(1);
            camelCasePropName = kebabToCamel(rawPropName);
            providedPropNames.add(camelCasePropName);
            attributesToRemove.push(attrName);
            rawProps.dynamic[camelCasePropName] = attrValue; // 存储表达式
        } else if (attrName.startsWith("@")) {
            const eventName = attrName.substring(1);
            attributesToRemove.push(attrName);
            // 【关键】创建绑定了正确上下文的可执行函数
            events[eventName] = (payload) => {
                const executionContext = Object.create(scope);
                executionContext.$event = payload;
                window.NueDirectives.evaluateExpression(attrValue, executionContext, false);
            };
        } else if (attrName !== "src" && attrName !== "ref" && attrName !== "n-show") {
            camelCasePropName = kebabToCamel(attrName);
            providedPropNames.add(camelCasePropName);
            attributesToRemove.push(attrName);
            rawProps.static[camelCasePropName] = attrValue;
        }
    }

    // 步骤 2: 根据 Schema 处理静态属性、创建响应式 Getter
    const finalProps = {};

    // 首先处理默认值
    for (const propName in propSchema) {
        const currentSchema = propSchema[propName]; // 【修复】使用一个新变量来存储当前 schema
        if (!providedPropNames.has(propName) && currentSchema.hasOwnProperty("default")) {
            const defaultValue = typeof currentSchema.default === "function" ? currentSchema.default() : currentSchema.default;
            rawProps.static[propName] = defaultValue;
        }
    }

    // 处理静态 Props (类型转换)
    for (const propName in rawProps.static) {
        let value = rawProps.static[propName];
        const schema = propSchema[propName];
        if (schema && schema.type) {
            const typeDef = schema.type;
            const types = Array.isArray(typeDef) ? typeDef : [typeDef];
            let convertedValue;
            let conversionSuccess = false;
            for (const type of types) {
                const converter = propTypeConverters[type.name || type];
                if (converter) {
                    convertedValue = converter(value);
                    if (convertedValue !== undefined) {
                        conversionSuccess = true;
                        break;
                    }
                } else {
                    convertedValue = value;
                    conversionSuccess = true;
                    break;
                }
            }
            if (conversionSuccess) value = convertedValue;
            else console.error(`Prop错误：[${componentName}] 的 Prop "${propName}" 的值 "${value}" 无法转换为指定的类型。`);
        }
        finalProps[propName] = value;
    }

    // 处理动态 Props (创建响应式 Getter)
    for (const propName in rawProps.dynamic) {
        const expression = rawProps.dynamic[propName];
        Object.defineProperty(finalProps, propName, {
            get() {
                // 当访问 props.myProp 时，执行此 getter
                // 它会在父作用域中对表达式求值，并自动解包 Signal
                return window.NueDirectives.evaluateExpression(expression, scope, true);
            },
            enumerable: true,
            configurable: true,
        });
    }

    return { props: finalProps, events, attributesToRemove };
}

/**
 * 【已重构】统一的 emit 函数创建器。
 * @param {object} eventHandlers - 由 parseAndProcessProps 创建的事件处理器映射。
 * @param {string} componentName - 子组件的名称。
 * @returns {Function} emit 函数。
 */
function createEmitFunction(eventHandlers, componentName = "子组件") {
    return function emit(eventName, payload) {
        const handler = eventHandlers[eventName];
        if (typeof handler === "function") {
            try {
                // 直接调用已经绑定好上下文的函数
                handler(payload);
            } catch (error) {
                console.error(`核心错误：执行 ${componentName} 的事件 "${eventName}" 处理器时出错:`, error);
            }
        }
    };
}

async function executeScript(scriptContent, initialProps = {}, emit = () => {}, componentOriginalUrl) {
    if (!scriptContent.trim()) {
        return { refs: {} };
    }
    try {
        const boundImportNjsForNue = (relativePath) => {
            return _loadAndExecuteNjsModule(relativePath, componentOriginalUrl);
        };
        const scriptArgNames = ["createSignal", "createWatch", "props", "emit", "importNjs"];
        const scriptArgValues = [createSignal, createWatch, initialProps, emit, boundImportNjsForNue];
        let dynamicScriptName;
        try {
            const urlObj = new URL(componentOriginalUrl);
            dynamicScriptName = `${urlObj.pathname}.temp.js`;
        } catch (e) {
            dynamicScriptName = `${componentOriginalUrl.replace(/[?#].*$/, "")}.temp.js`;
        }
        dynamicScriptName = encodeURI(dynamicScriptName);
        const wrappedScriptContent = `return (async () => { \n${scriptContent}\n })(); \n//# sourceURL=${dynamicScriptName}`;
        const scriptFunction = new Function(...scriptArgNames, wrappedScriptContent);
        const componentScopePromise = scriptFunction(...scriptArgValues);
        const componentScope = await componentScopePromise;
        if (typeof componentScope === "object" && componentScope !== null) {
            if (!componentScope.refs) {
                componentScope.refs = {};
            }
            return componentScope;
        } else {
            console.warn(`核心警告：组件 ${componentOriginalUrl} 的脚本未返回一个对象。将创建一个空作用域。`);
            return { refs: {} };
        }
    } catch (error) {
        throw error;
    }
}

// [REPLACE] 最终修复版: 修正了指令处理优先级的 compileNode
async function compileNode(node, scope, directiveHandlers, parentComponentName = "根组件", currentContextOriginalUrl = null) {
    if (!directiveHandlers || typeof directiveHandlers.evaluateExpression !== "function") {
        console.error(`核心错误：[${parentComponentName}] 指令处理器或 evaluateExpression 未准备好，编译中止。`);
        return;
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node;
        const tagName = element.tagName.toLowerCase();

        // =================================================================
        // 步骤 1: 结构性指令优先处理 (最高优先级)
        // =================================================================
        const nIfAttr = element.getAttribute("n-if");
        if (nIfAttr !== null) {
            directiveHandlers.handleNIf(element, nIfAttr, scope, (node, s, dh, cn) => compileNode(node, s, dh, cn, currentContextOriginalUrl), directiveHandlers, parentComponentName);
            return;
        }
        const nForAttr = element.getAttribute("n-for");
        if (nForAttr !== null) {
            // 这里的 compileFn 就是 compileNode 自身，它会处理克隆出的每个元素
            directiveHandlers.handleNFor(element, nForAttr, scope, compileNode, directiveHandlers, parentComponentName);
            return;
        }

        // =================================================================
        // 步骤 2: 区分组件类型
        // =================================================================
        const isNueComponent = tagName.includes("-") && !window.customElements.get(tagName);
        const isWebComponent = tagName.includes("-") && window.customElements.get(tagName);

        if (isNueComponent) {
            // -------------------------------------------------
            // 2.1 处理 Nue 组件
            // -------------------------------------------------
            const componentName = tagName;
            const { props, events, attributesToRemove } = parseAndProcessProps(element, scope, {}, componentName);
            attributesToRemove.forEach((attrName) => element.removeAttribute(attrName));

            const srcAttr = element.getAttribute("src");
            const rawComponentPath = srcAttr ? srcAttr : `${tagName}.nue`;
            if (srcAttr) element.removeAttribute("src");
            const { versionedUrl: childVersionedUrl, originalUrl: childOriginalUrl } = getVersionedAndOriginalUrls(rawComponentPath, currentContextOriginalUrl);

            const slotsDataForChild = {};
            const slotContentContainer = document.createDocumentFragment();
            Array.from(element.childNodes).forEach((cn) => slotContentContainer.appendChild(cn));
            const rawSlotContents = { default: [] };
            Array.from(slotContentContainer.childNodes).forEach((childNode) => {
                if (childNode.nodeType === Node.ELEMENT_NODE && childNode.tagName.toLowerCase() === "template") {
                    if (childNode.hasAttribute("slot")) {
                        let slotNameAttr = (childNode.getAttribute("slot") || "").trim() || "default";
                        if (!rawSlotContents[slotNameAttr]) rawSlotContents[slotNameAttr] = [];
                        const templateContent = childNode.content;
                        if (templateContent) Array.from(templateContent.childNodes).forEach((c) => rawSlotContents[slotNameAttr].push(c.cloneNode(true)));
                    } else {
                        const templateContent = childNode.content;
                        if (templateContent) Array.from(templateContent.childNodes).forEach((c) => rawSlotContents.default.push(c.cloneNode(true)));
                    }
                } else if (!(childNode.nodeType === Node.TEXT_NODE && childNode.nodeValue.trim() === "")) {
                    rawSlotContents.default.push(childNode.cloneNode(true));
                }
            });
            for (const sName in rawSlotContents) {
                if (rawSlotContents[sName].length > 0) {
                    slotsDataForChild[sName] = { nodes: rawSlotContents[sName], parentScope: scope, parentContextOriginalUrl: currentContextOriginalUrl };
                }
            }

            const placeholder = document.createComment(`component-placeholder: ${tagName}`);
            if (!element.parentNode) {
                console.error(`核心错误：[${parentComponentName}] 子组件 <${tagName}> 在替换为占位符前已无父节点。`);
                return;
            }
            element.parentNode.replaceChild(placeholder, element);

            await mountComponent(childVersionedUrl, placeholder, props, events, tagName, slotsDataForChild, childOriginalUrl);
            return;
        }

        // =================================================================
        // 步骤 3: 处理属性、事件和其他指令
        // =================================================================
        const attributesToRemoveAfterProcessing = [];
        for (const attr of Array.from(element.attributes)) {
            const attrName = attr.name;
            const attrValue = attr.value;
            if (attrName.startsWith(":")) {
                if (directiveHandlers.handleAttributeBinding) directiveHandlers.handleAttributeBinding(element, attrName.substring(1), attrValue, scope, parentComponentName);
                attributesToRemoveAfterProcessing.push(attrName);
            } else if (attrName.startsWith("@")) {
                const eventName = attrName.substring(1);
                const handlerExpression = attrValue.trim();
                element.addEventListener(eventName, (event) => {
                    try {
                        const executionContext = Object.create(scope);
                        executionContext.$event = event;
                        const isMethodNameOnly = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(handlerExpression);
                        if (isMethodNameOnly) {
                            const handlerFn = directiveHandlers.evaluateExpression(handlerExpression, executionContext, false);
                            if (typeof handlerFn === "function") {
                                handlerFn.call(scope, event);
                            } else {
                                console.warn(`指令警告：[${parentComponentName}] 事件处理器 "${handlerExpression}" 解析得到一个非函数值。`);
                            }
                        } else {
                            directiveHandlers.evaluateExpression(handlerExpression, executionContext, false);
                        }
                    } catch (error) {
                        console.error(`核心错误：[${parentComponentName}] 在执行事件处理器 "${handlerExpression}" 期间发生意外错误:`, error);
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

        if (isWebComponent) {
            // -------------------------------------------------
            // 3.1 如果是 Web Component，处理完属性后就“放行”
            // -------------------------------------------------
            return;
        }

        // =================================================================
        // 步骤 4: 处理普通元素的剩余逻辑 (ref, slot, 子节点)
        // =================================================================
        const refName = element.getAttribute("ref");
        if (refName) {
            scope.refs[refName] = element;
            element.removeAttribute("ref");
        }

        if (tagName === "slot") {
            const slotName = element.getAttribute("name") || "default";
            const slotDataFromParent = scope.$slots && scope.$slots[slotName];
            const parentOfSlotTag = element.parentNode;
            if (parentOfSlotTag) {
                let nodesToCompileInSlot = [];
                let slotScope = scope;
                let slotContextUrl = currentContextOriginalUrl;
                let slotParentName = `${parentComponentName} (slot '${slotName}' fallback)`;
                if (slotDataFromParent && slotDataFromParent.nodes && slotDataFromParent.nodes.length > 0) {
                    const { nodes, parentScope, parentContextOriginalUrl } = slotDataFromParent;
                    nodesToCompileInSlot = nodes.map((n) => n.cloneNode(true));
                    slotScope = parentScope;
                    slotContextUrl = parentContextOriginalUrl;
                    slotParentName = `${parentComponentName} (slot '${slotName}' content from parent)`;
                } else {
                    nodesToCompileInSlot = Array.from(element.childNodes);
                }
                const contentFragmentForSlot = document.createDocumentFragment();
                nodesToCompileInSlot.forEach((node) => contentFragmentForSlot.appendChild(node));
                const compileSlotPromises = Array.from(contentFragmentForSlot.childNodes).map((node) => compileNode(node, slotScope, directiveHandlers, slotParentName, slotContextUrl));
                await Promise.all(compileSlotPromises);
                parentOfSlotTag.insertBefore(contentFragmentForSlot, element);
                parentOfSlotTag.removeChild(element);
            } else {
                console.warn(`核心警告：[${parentComponentName}] <slot name="${slotName}"> 标签无父节点，无法渲染。`);
            }
            return;
        }

        // 编译普通元素的子节点
        const compileChildPromises = Array.from(element.childNodes).map((child) => compileNode(child, scope, directiveHandlers, `${parentComponentName} > ${element.tagName.toUpperCase()}`, currentContextOriginalUrl));
        await Promise.all(compileChildPromises);
    } else if (node.nodeType === Node.TEXT_NODE) {
        // 文本节点的处理逻辑保持不变
        const textContent = node.textContent || "";
        const mustacheRegex = /\{\{([^}]+)\}\}/g;
        if (!mustacheRegex.test(textContent)) return;
        const segments = [];
        let lastIndex = 0;
        let match;
        mustacheRegex.lastIndex = 0;
        while ((match = mustacheRegex.exec(textContent)) !== null) {
            if (match.index > lastIndex) {
                segments.push(document.createTextNode(textContent.substring(lastIndex, match.index)));
            }
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
        if (lastIndex < textContent.length) {
            segments.push(document.createTextNode(textContent.substring(lastIndex)));
        }
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
    if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.COMMENT_NODE) {
        if (node.nodeType === Node.ELEMENT_NODE && node.hasChildNodes()) {
            Array.from(node.childNodes).forEach((child) => cleanupAndRemoveNode(child));
        }
        if (componentEffectsRegistry.has(node)) {
            const effectsToStop = componentEffectsRegistry.get(node);
            effectsToStop.forEach((stopFn) => {
                try {
                    stopFn();
                } catch (error) {
                    console.error(`核心错误：自动清理 Effect 时出错 (节点: ${node.nodeName}):`, error);
                }
            });
            componentEffectsRegistry.delete(node);
        }
        const cleanupCallback = componentCleanupRegistry.get(node);
        if (typeof cleanupCallback === "function") {
            try {
                cleanupCallback();
            } catch (error) {
                console.error(`核心错误：执行 onUnmount 钩子时出错 (节点: ${node.nodeName}):`, error);
            }
            componentCleanupRegistry.delete(node);
        }
    }
    if (node.parentNode) {
        node.parentNode.removeChild(node);
    }
}

async function mountComponent(componentFile, targetSelectorOrElement, initialProps = {}, eventHandlers = {}, componentNameSuggestion, slotsDataFromParent = {}, baseResolutionUrlOverride) {
    const { versionedUrl: versionedComponentUrl, originalUrl: originalAbsoluteUrl } = getVersionedAndOriginalUrls(componentFile, baseResolutionUrlOverride || null);
    let componentName = componentNameSuggestion;
    if (!componentName) {
        const fileName = originalAbsoluteUrl.substring(originalAbsoluteUrl.lastIndexOf("/") + 1);
        const nameParts = fileName.split(".");
        componentName = nameParts[0] || "组件";
    }
    let targetElement = null;
    let isPlaceholder = false;
    if (typeof targetSelectorOrElement === "string") {
        targetElement = document.querySelector(targetSelectorOrElement);
        if (!targetElement) {
            console.error(`核心错误：[${componentName}] 挂载失败，找不到目标元素 "${targetSelectorOrElement}"`);
            return null;
        }
    } else if (targetSelectorOrElement instanceof Element || targetSelectorOrElement instanceof Comment) {
        targetElement = targetSelectorOrElement;
        isPlaceholder = targetSelectorOrElement instanceof Comment;
        if (isPlaceholder && !targetElement.parentNode) {
            console.error(`核心错误：[${componentName}] 挂载失败，注释占位符已脱离 DOM`);
            return null;
        }
    } else {
        console.error(`核心错误：[${componentName}] 挂载失败，无效的目标类型:`, targetSelectorOrElement);
        return null;
    }
    const effectsForThisComponent = [];
    const previousEffectCleanupList = _currentEffectCleanupList;
    _currentEffectCleanupList = effectsForThisComponent;
    let mountedRootNode = null;
    try {
        const componentText = await fetchAndCacheComponentText(versionedComponentUrl, originalAbsoluteUrl);
        let cacheEntry = componentCache.get(versionedComponentUrl);
        if (!cacheEntry) {
            cacheEntry = { text: componentText, structure: null, templateElement: null, originalUrl: originalAbsoluteUrl };
            componentCache.set(versionedComponentUrl, cacheEntry);
        }
        if (!cacheEntry.structure) {
            cacheEntry.structure = parseComponentStructure(componentText, versionedComponentUrl);
        }
        const { template, script, style } = cacheEntry.structure;

        const emit = createEmitFunction(eventHandlers, componentName);
        const componentScope = await executeScript(script, initialProps, emit, originalAbsoluteUrl);

        if (componentScope && typeof componentScope === "object") {
            componentScope.$slots = slotsDataFromParent;
        }

        let fragment;
        if (cacheEntry.templateElement) {
            fragment = cacheEntry.templateElement.content.cloneNode(true);
        } else {
            const templateEl = document.createElement("template");
            templateEl.innerHTML = template.trim();
            cacheEntry.templateElement = templateEl;
            fragment = templateEl.content.cloneNode(true);
        }

        const topLevelNodesInFragment = Array.from(fragment.childNodes);
        mountedRootNode = topLevelNodesInFragment[0] || null;

        // [MODIFIED] 移除 rootContext 的创建和传递
        const compilePromises = topLevelNodesInFragment.map((node) => compileNode(node, componentScope, window.NueDirectives, componentName, originalAbsoluteUrl));
        await Promise.all(compilePromises);

        injectStyles(style, originalAbsoluteUrl);
        if (isPlaceholder) {
            const parent = targetElement.parentNode;
            if (parent) {
                parent.insertBefore(fragment, targetElement);
                parent.removeChild(targetElement);
            }
        } else {
            cleanupAndRemoveNode(targetElement.firstChild);
            targetElement.innerHTML = "";
            targetElement.appendChild(fragment);
        }
        if (mountedRootNode && effectsForThisComponent.length > 0) {
            componentEffectsRegistry.set(mountedRootNode, new Set(effectsForThisComponent));
        }
        if (mountedRootNode && componentScope && typeof componentScope.onMount === "function") {
            try {
                await componentScope.onMount();
            } catch (error) {
                console.error(`核心错误：[${componentName}] 执行 onMount 钩子时出错:`, error);
            }
        }
        if (mountedRootNode && componentScope && typeof componentScope.onUnmount === "function") {
            componentCleanupRegistry.set(mountedRootNode, componentScope.onUnmount);
        }
        return mountedRootNode;
    } catch (error) {
        console.error(`核心错误：挂载组件 ${componentName} (源文件: ${originalAbsoluteUrl}) 失败:`, error);
        if (targetElement instanceof Element && !isPlaceholder) {
            targetElement.innerHTML = `<p style="color:red;">组件 ${componentName} (源: ${originalAbsoluteUrl}) 加载或渲染失败。详情请查看控制台。</p>`;
        } else if (isPlaceholder && targetElement.parentNode) {
            const errorNode = document.createTextNode(` [组件 ${componentName} (源: ${originalAbsoluteUrl}) 渲染错误，详见控制台] `);
            targetElement.parentNode.insertBefore(errorNode, targetElement.nextSibling);
        }
        return null;
    } finally {
        _currentEffectCleanupList = previousEffectCleanupList;
    }
}

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
                console.warn(`核心警告：提供的应用版本号无效，组件将不带版本参数加载，localStorage 缓存将不基于版本。`);
            }
        }
        const targetSelector = `#${targetId}`;
        return mountComponent(rootComponentFile, targetSelector, initialProps);
    },
    exportDependencyBundle: function (filename = "nue-data-bundle.js") {
        const dataToExport = {};
        let exportedCount = 0;
        for (const [versionedUrl, cacheEntry] of componentCache.entries()) {
            if (cacheEntry && cacheEntry.originalUrl && typeof cacheEntry.text === "string") {
                const confusedText = nueSimpleTransform(cacheEntry.text, __NUE_CONFUSION_KEY__);
                dataToExport[cacheEntry.originalUrl] = confusedText;
                exportedCount++;
            } else {
                console.warn(`[NueCore.exportDependencyBundle] 跳过缓存条目 (版本化URL: ${versionedUrl})，因为它缺少 originalUrl 或文本内容。`);
            }
        }
        if (exportedCount === 0) {
            const message = "[NueCore.exportDependencyBundle] 缓存中没有找到可导出的组件或NJS模块数据。\n请确保您的应用已加载了至少一个 Nue 组件或 NJS 模块。";
            console.warn(message);
            if (typeof alert === "function") {
                alert(message);
            }
            return;
        }
        const dataString = `window.__NUE_PRELOADED_DATA__ = ${JSON.stringify(dataToExport, null, "  ")};`;
        const blob = new Blob([dataString], { type: "application/javascript;charset=utf-8" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(link.href);
        console.log(`[NueCore.exportDependencyBundle] ${exportedCount} 个资源的混淆数据已导出为 ${filename}。\n请将此文件包含在您的 HTML 中，并置于 nono-core.js 脚本之前。`);
    },
    createSignal,
    createEffect,
    createWatch,
    createUrlWatch,
    navigateTo,
    compileNode,
    cleanupAndRemoveNode,
};
