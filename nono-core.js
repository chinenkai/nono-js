// nono-core.js

// ==================================
// 0. 核心配置
// ==================================
const NueCoreConfig = {
    appVersion: null, // 应用版本号，用于缓存控制
};

// ==================================
// 1. Signal 核心实现 (与之前相同)
// ==================================
let currentEffect = null; // 当前正在执行的副作用函数

/**
 * 创建一个响应式信号。
 * @param {*} initialValue 初始值
 * @returns {Function} 信号访问器函数。无参数调用时读取值，有参数调用时设置值。
 */
function createSignal(initialValue) {
    let value = initialValue;
    const subscribers = new Set(); // 存储订阅该信号的副作用函数

    function signalAccessor(newValue) {
        if (arguments.length === 0) {
            // 读取操作
            if (currentEffect) {
                subscribers.add(currentEffect); // 依赖收集
            }
            return value;
        } else {
            // 写入操作
            if (value !== newValue) {
                value = newValue;
                // 触发所有订阅的副作用函数，使用副本以避免迭代问题
                [...subscribers].forEach((effect) => effect());
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
// componentCache 存储已成功加载和解析的组件数据
// key: versionedUrl (带版本号的完整 URL)
// value: { text: string, structure: object, ast: object, originalUrl: string }
//        originalUrl 是不带版本号的原始组件URL，用于style ID和子组件src路径解析基准
const componentCache = new Map();

// _pendingRequests 存储正在进行中的组件加载请求的 Promise
// key: versionedUrl (带版本号的完整 URL)
// value: Promise<string> (Promise 解析为组件文本)
const _pendingRequests = new Map();

// componentCleanupRegistry 存储组件根元素与其 onUnmount 回调的映射
const componentCleanupRegistry = new WeakMap();

// ==================================
// 2.1. 辅助函数
// ==================================
const LOCAL_STORAGE_PREFIX = "nue_component_cache_";

/**
 * 从 localStorage 获取缓存的组件文本。
 * @param {string} versionedUrl - 带版本号的完整组件 URL。
 * @returns {string | null} 组件文本，如果未找到或版本不匹配则返回 null。
 */
function getComponentFromLocalStorage(versionedUrl) {
    if (!NueCoreConfig.appVersion) {
        // 如果没有应用版本，不使用 localStorage 缓存
        return null;
    }
    const cacheKey = LOCAL_STORAGE_PREFIX + versionedUrl;
    try {
        const cachedItem = localStorage.getItem(cacheKey);
        if (cachedItem) {
            const { text, version } = JSON.parse(cachedItem);
            // 确保 localStorage 中的版本与当前应用版本一致
            if (version === NueCoreConfig.appVersion && typeof text === "string") {
                console.log(`核心信息：从 localStorage 加载组件 ${versionedUrl}`);
                return text;
            } else {
                // 版本不匹配或数据损坏，移除旧缓存
                localStorage.removeItem(cacheKey);
                return null;
            }
        }
    } catch (e) {
        console.warn(`核心警告：从 localStorage 读取组件 ${versionedUrl} 失败:`, e);
        try {
            localStorage.removeItem(cacheKey);
        } catch (removeError) {} // 尝试移除损坏的条目
        return null;
    }
    return null;
}

/**
 * 将组件文本存入 localStorage。
 * @param {string} versionedUrl - 带版本号的完整组件 URL。
 * @param {string} text - 组件文本。
 */
function setComponentToLocalStorage(versionedUrl, text) {
    if (!NueCoreConfig.appVersion) {
        // 如果没有应用版本，不存入 localStorage
        return;
    }
    const cacheKey = LOCAL_STORAGE_PREFIX + versionedUrl;
    const itemToStore = JSON.stringify({
        text: text,
        version: NueCoreConfig.appVersion, // 存储当前应用版本
    });
    try {
        localStorage.setItem(cacheKey, itemToStore);
    } catch (e) {
        console.warn(`核心警告：存入 localStorage 组件 ${versionedUrl} 失败 (可能已满):`, e);
        // 可以考虑在这里实现一些清理策略，例如移除最旧的条目
        // 但对于简单框架，可能只是警告
    }
}

/**
 * (可选) 在应用初始化时清理旧版本的 localStorage 缓存。
 * 可以在 NueCore.init 中调用。
 */
function cleanupOldLocalStorageCache() {
    if (!NueCoreConfig.appVersion) return; // 没有版本号无法判断

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
                            console.log(`核心信息：已从 localStorage 移除旧版本组件缓存: ${key}`);
                            i--; // 因为移除了一个元素，所以要调整索引
                        }
                    }
                } catch (e) {
                    // 解析失败或条目损坏，也移除
                    localStorage.removeItem(key);
                    i--;
                }
            }
        }
    } catch (e) {
        console.warn("核心警告：清理旧 localStorage 缓存时出错:", e);
    }
}

/**
 * 根据基础 URL 和相对路径，解析出绝对 URL。
 * @param {string} relativeOrAbsoluteUrl - 需要解析的 URL，可以是相对或绝对路径。
 * @param {string} [baseComponentUrl] - 父组件的 URL (不带查询参数)，作为解析相对路径的基准。如果未提供，则相对于当前文档位置。
 * @returns {string} 解析后的绝对 URL (不带查询参数)。
 */
function resolveUrl(relativeOrAbsoluteUrl, baseComponentUrl) {
    // 检查是否已经是绝对路径或协议相对路径
    if (/^(?:[a-z]+:)?\/\//i.test(relativeOrAbsoluteUrl) || relativeOrAbsoluteUrl.startsWith("/")) {
        // 如果是绝对路径但没有协议 (如 /path/to/file)，则基于当前 origin
        if (relativeOrAbsoluteUrl.startsWith("/") && !relativeOrAbsoluteUrl.startsWith("//")) {
            return new URL(relativeOrAbsoluteUrl, window.location.origin).href;
        }
        return new URL(relativeOrAbsoluteUrl, window.location.origin).href; // 确保是标准的绝对URL
    }
    try {
        // 如果 baseComponentUrl 存在，则以它为基准；否则以当前页面为基准
        const base = baseComponentUrl ? new URL(baseComponentUrl, window.location.origin) : new URL(window.location.href);
        return new URL(relativeOrAbsoluteUrl, base).href;
    } catch (e) {
        console.warn(`核心警告：解析 URL "${relativeOrAbsoluteUrl}" (基准: "${baseComponentUrl || window.location.href}") 失败，将按原样使用。错误:`, e);
        return relativeOrAbsoluteUrl; // 解析失败则返回原始值 (可能导致后续问题)
    }
}

/**
 * 获取带版本号的组件 URL。
 * @param {string} rawUrl - 组件的原始 URL (可能相对父组件或页面)。
 * @param {string} [baseComponentUrlForResolution] - 父组件的 URL (不带查询参数)，用于解析相对路径的 rawUrl。
 * @returns {{versionedUrl: string, originalUrl: string}} 包含带版本号的URL和不带版本号的原始绝对URL的对象。
 */
function getVersionedAndOriginalUrls(rawUrl, baseComponentUrlForResolution) {
    // 1. 解析为绝对的原始 URL (不带版本号)
    const originalAbsoluteUrl = resolveUrl(rawUrl, baseComponentUrlForResolution);

    // 2. 基于原始绝对 URL 生成带版本号的 URL
    let versionedUrl = originalAbsoluteUrl;
    if (NueCoreConfig.appVersion) {
        try {
            const urlObj = new URL(originalAbsoluteUrl);
            urlObj.searchParams.set("v", NueCoreConfig.appVersion);
            versionedUrl = urlObj.href;
        } catch (e) {
            console.warn(`核心警告：为 URL "${originalAbsoluteUrl}" 添加版本号失败，将使用原始URL。错误:`, e);
            // versionedUrl 保持为 originalAbsoluteUrl
        }
    }
    return { versionedUrl, originalUrl: originalAbsoluteUrl };
}

// ==================================
// 3. 组件处理核心函数
// ==================================

/**
 * 解析 .nue 文件内容，提取 template, script, style。
 * @param {string} text .nue 文件文本内容
 * @param {string} versionedUrl 用于缓存的带版本号的URL
 * @returns {{template: string, script: string, style: string}} 包含各部分内容的对象
 */
function parseComponentStructure(text, versionedUrl) {
    const cached = componentCache.get(versionedUrl);
    // 确保缓存条目存在且 structure 尚未解析
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
        // 只有当缓存条目已存在时才更新 (由 fetchAndCacheComponentText 创建)
        cached.structure = structure;
    }
    return structure;
}

/**
 * 使用 Acorn 解析脚本内容为 AST (抽象语法树)。
 * @param {string} scriptContent 脚本字符串
 * @param {string} versionedUrl 用于缓存的带版本号的URL
 * @returns {object | null} Acorn AST 对象，或在失败时返回 null
 */
function parseScriptWithAcorn(scriptContent, versionedUrl) {
    const cached = componentCache.get(versionedUrl);
    // 确保缓存条目存在且 ast 尚未解析
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
            allowReturnOutsideFunction: true, // 允许顶层 return
        });
        if (cached) {
            // 只有当缓存条目已存在时才更新
            cached.ast = ast;
        }
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

/**
 * 创建供子组件使用的 emit 函数。
 * @param {object} eventHandlers - 父组件提供的事件处理器映射 { eventName: handlerFunc }
 * @param {string} componentName - 用于日志记录的组件名
 * @returns {Function} emit 函数 (eventName, payload) => void
 */
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

/**
 * 将 kebab-case 字符串转换为 camelCase。
 * @param {string} kebabCase 输入字符串
 * @returns {string} camelCase 字符串
 */
function kebabToCamel(kebabCase) {
    return kebabCase.replace(/-([a-z])/g, (match, letter) => letter.toUpperCase());
}

/**
 * 加载并缓存组件文本。处理并发请求，并使用 localStorage。
 * 此函数确保对同一 versionedUrl 的 fetch 只发生一次（如果 localStorage 未命中）。
 * @param {string} versionedUrl - 带版本号的完整组件 URL。
 * @param {string} originalAbsoluteUrl - 不带版本号的原始绝对 URL (用于存入内存缓存条目)。
 * @returns {Promise<string>} Promise 解析为组件文本。
 */
async function fetchAndCacheComponentText(versionedUrl, originalAbsoluteUrl) {
    // 0. 尝试从 localStorage 获取 (如果版本匹配)
    const localStorageText = getComponentFromLocalStorage(versionedUrl);
    if (localStorageText !== null) {
        // 如果从 localStorage 成功获取，确保它也在内存缓存 componentCache 中
        // 这样后续的 parseStructure, parseAst 仍然可以利用内存缓存
        if (!componentCache.has(versionedUrl)) {
            componentCache.set(versionedUrl, { text: localStorageText, structure: null, ast: null, originalUrl: originalAbsoluteUrl });
        } else {
            // 如果内存缓存已存在，确保文本是最新的 (理论上应该一致)
            componentCache.get(versionedUrl).text = localStorageText;
        }
        return localStorageText;
    }

    // 1. 检查内存缓存 (componentCache) 是否已有此版本的组件数据 (可能由并发请求填充)
    if (componentCache.has(versionedUrl)) {
        return componentCache.get(versionedUrl).text;
    }

    // 2. 检查是否有正在进行的对此 versionedUrl 的请求
    if (_pendingRequests.has(versionedUrl)) {
        return _pendingRequests.get(versionedUrl); // 返回已存在的 Promise
    }

    // 3. 发起新的 fetch 请求
    console.log(`核心信息：开始网络加载组件 ${versionedUrl} (localStorage 未命中或版本不符)`);
    const fetchPromise = fetch(versionedUrl)
        .then((response) => {
            if (!response.ok) {
                throw new Error(`加载组件 ${versionedUrl} 失败: ${response.status} ${response.statusText}`);
            }
            return response.text();
        })
        .then((text) => {
            // 文本加载成功
            // a. 存入内存缓存 componentCache
            componentCache.set(versionedUrl, { text, structure: null, ast: null, originalUrl: originalAbsoluteUrl });

            // b. 存入 localStorage
            setComponentToLocalStorage(versionedUrl, text);

            _pendingRequests.delete(versionedUrl); // 从挂起请求中移除
            return text;
        })
        .catch((error) => {
            _pendingRequests.delete(versionedUrl); // 出错也要移除
            console.error(`核心错误：获取组件 ${versionedUrl} 文本失败:`, error);
            throw error; // 重新抛出，让调用者 (mountComponent) 处理
        });

    _pendingRequests.set(versionedUrl, fetchPromise); // 存储 Promise 以处理并发
    return fetchPromise;
}

/**
 * 编译 DOM 节点，处理指令和插值。
 * @param {Node} node 当前处理的 DOM 节点
 * @param {object} scope 组件的作用域对象
 * @param {object} directiveHandlers 包含指令处理函数的对象
 * @param {string} [parentComponentName='根组件'] 父组件名称，用于日志
 * @param {string} [currentContextOriginalUrl=null] 当前正在编译的这个组件的原始绝对URL (不带版本号)，
 *                                                用于解析其模板中子组件的相对 `src` 路径。
 */
function compileNode(node, scope, directiveHandlers, parentComponentName = "根组件", currentContextOriginalUrl = null) {
    if (!directiveHandlers || typeof directiveHandlers.evaluateExpression !== "function") {
        console.error(`核心错误：[${parentComponentName}] 指令处理器或 evaluateExpression 未准备好，编译中止。`);
        return;
    }

    // 1. 处理元素节点
    if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node;
        const tagName = element.tagName.toLowerCase();

        // 1.1 处理子组件标签
        // 自定义元素通常包含连字符，且不是 HTML 内置的特殊标签
        if (tagName.includes("-") && !["template", "script", "style", "slot"].includes(tagName)) {
            // 检查 src 属性，否则使用 tagName 约定作为原始文件名/路径
            const srcAttr = element.getAttribute("src");
            const rawComponentPath = srcAttr ? srcAttr : `${tagName}.nue`;

            // 解析子组件的 URL (带版本和不带版本)
            // currentContextOriginalUrl 是当前父组件的原始URL，作为解析基准
            const { versionedUrl: childVersionedUrl, originalUrl: childOriginalUrl } = getVersionedAndOriginalUrls(rawComponentPath, currentContextOriginalUrl);

            const initialProps = {};
            const eventHandlers = {};
            const attributesToRemove = []; // 收集需要移除的属性

            // 解析 Props 和事件
            for (const attr of Array.from(element.attributes)) {
                const attrName = attr.name;
                const attrValue = attr.value;

                if (attrName === "src") {
                    // src 属性已被用于路径指定，应从DOM中移除
                    attributesToRemove.push(attrName);
                    continue;
                }

                if (attrName.startsWith(":")) {
                    // 动态 Prop
                    const rawPropName = attrName.substring(1);
                    const camelCasePropName = kebabToCamel(rawPropName);
                    const expression = attrValue;
                    const propSignal = createSignal(undefined); // Props 也用 Signal 包装，以便响应式更新
                    createEffect(() => {
                        try {
                            propSignal(directiveHandlers.evaluateExpression(expression, scope));
                        } catch (error) {
                            console.error(`核心错误：[${parentComponentName}] 计算动态 Prop "${rawPropName}" (${attrName}) 表达式 "${expression}" 出错:`, error);
                            propSignal(undefined); // 出错时设为 undefined
                        }
                    });
                    initialProps[camelCasePropName] = propSignal;
                    attributesToRemove.push(attrName);
                } else if (attrName.startsWith("@")) {
                    // 事件监听
                    const eventName = attrName.substring(1);
                    const handlerExpression = attrValue;
                    eventHandlers[eventName] = (payload) => {
                        // 创建事件处理器
                        try {
                            const context = Object.create(scope); // 创建一个继承自父作用域的临时上下文
                            context.$event = payload; // 将事件载荷注入上下文
                            // 执行父组件中定义的事件处理表达式
                            const result = directiveHandlers.evaluateExpression(handlerExpression, context);
                            // 如果表达式本身就是一个函数名，并且求值结果是函数，则以父组件scope为this调用它
                            if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(handlerExpression.trim()) && typeof result === "function") {
                                result.call(scope, payload);
                            }
                        } catch (error) {
                            console.error(`核心错误：[${parentComponentName}] 执行子组件事件处理器 "${handlerExpression}" 出错:`, error);
                        }
                    };
                    attributesToRemove.push(attrName);
                } else {
                    // 静态 Prop
                    initialProps[kebabToCamel(attrName)] = attrValue;
                }
            }

            // 解析插槽内容
            const parsedSlots = {};
            const slotContentContainer = document.createDocumentFragment(); // 临时容器存放子组件的子节点
            const tempChildNodes = Array.from(element.childNodes); // 创建快照以安全移动
            tempChildNodes.forEach((cn) => slotContentContainer.appendChild(cn)); // 将子节点移到临时容器

            const rawSlotContents = { default: [] }; // 存储原始插槽内容节点
            Array.from(slotContentContainer.childNodes).forEach((childNode) => {
                if (childNode.nodeType === Node.ELEMENT_NODE && childNode.tagName.toLowerCase() === "template") {
                    // 处理 <template slot="name">
                    if (childNode.hasAttribute("slot")) {
                        let slotNameAttr = (childNode.getAttribute("slot") || "").trim();
                        if (!slotNameAttr) {
                            // 空 slot 名视为默认
                            const templateContent = childNode.content; // 获取 <template> 的 DocumentFragment
                            if (templateContent) Array.from(templateContent.childNodes).forEach((c) => rawSlotContents.default.push(c.cloneNode(true)));
                        } else {
                            if (!rawSlotContents[slotNameAttr]) rawSlotContents[slotNameAttr] = [];
                            const templateContent = childNode.content;
                            if (templateContent) Array.from(templateContent.childNodes).forEach((c) => rawSlotContents[slotNameAttr].push(c.cloneNode(true)));
                        }
                    } else {
                        // 无 slot 属性的 template 内容归入默认插槽
                        const templateContent = childNode.content;
                        if (templateContent) Array.from(templateContent.childNodes).forEach((c) => rawSlotContents.default.push(c.cloneNode(true)));
                    }
                } else if (!(childNode.nodeType === Node.TEXT_NODE && childNode.nodeValue.trim() === "")) {
                    // 非空白文本节点和非 template 元素归入默认插槽
                    rawSlotContents.default.push(childNode.cloneNode(true));
                }
            });

            // 编译插槽内容 (在父组件的作用域和上下文中编译)
            for (const sName in rawSlotContents) {
                const compiledSlotFragment = document.createDocumentFragment();
                if (rawSlotContents[sName].length > 0) {
                    rawSlotContents[sName].forEach((n) => compiledSlotFragment.appendChild(n));
                    Array.from(compiledSlotFragment.childNodes).forEach((nodeToCompile) => {
                        // 插槽内容是在父组件的上下文中编译的，所以 currentContextOriginalUrl 是父组件的URL
                        compileNode(nodeToCompile, scope, directiveHandlers, `${parentComponentName} (slot '${sName}')`, currentContextOriginalUrl);
                    });
                }
                parsedSlots[sName] = compiledSlotFragment; // 存储编译好的插槽 DocumentFragment
            }

            attributesToRemove.forEach((attrName) => element.removeAttribute(attrName)); // 移除已处理的属性
            const placeholder = document.createComment(`component-placeholder: ${tagName}`); // 创建占位符
            if (!element.parentNode) {
                console.error(`核心错误：[${parentComponentName}] 子组件 <${tagName}> 在替换为占位符前已无父节点。`);
                return; // 无法继续
            }
            element.parentNode.replaceChild(placeholder, element); // 用占位符替换原子组件标签

            // 异步挂载子组件，传递解析好的 URL
            mountComponent(
                childVersionedUrl, // componentFile (已是版本化的绝对路径)
                placeholder, // targetSelectorOrElement
                initialProps, // initialProps
                eventHandlers, // eventHandlers (父组件传给子组件的)
                tagName, // componentNameSuggestion
                parsedSlots, // parsedSlots
                childOriginalUrl, // baseResolutionUrlOverride (对于子组件，这是其自身的 originalUrl)
            ).catch((error) => console.error(`核心错误：[${parentComponentName}] 异步挂载子组件 <${tagName}> (${childVersionedUrl}) 失败:`, error));
            return;
        }

        // 1.2 处理结构性指令 (n-if, n-for) - 它们会改变DOM结构，应优先处理
        const nIfAttr = element.getAttribute("n-if");
        if (nIfAttr !== null) {
            // n-if 内部可能包含其他组件，所以递归编译时要传递 currentContextOriginalUrl
            directiveHandlers.handleNIf(element, nIfAttr, scope, (node, s, dh, cn) => compileNode(node, s, dh, cn, currentContextOriginalUrl), directiveHandlers, parentComponentName);
            return; // n-if 已处理，其内容由指令内部逻辑控制编译和挂载
        }
        const nForAttr = element.getAttribute("n-for");
        if (nForAttr !== null) {
            // n-for 生成的列表项内部也可能包含组件
            directiveHandlers.handleNFor(element, nForAttr, scope, (node, s, dh, cn) => compileNode(node, s, dh, cn, currentContextOriginalUrl), directiveHandlers, parentComponentName);
            return; // n-for 已处理
        }

        // 1.3 处理 <slot> 标签 (在子组件模板内部渲染插槽)
        if (tagName === "slot") {
            const slotName = element.getAttribute("name") || "default";
            // scope.$slots 是由父组件在 mountComponent 时注入到子组件 scope 中的
            const providedContentFragment = scope.$slots && scope.$slots[slotName];
            const parentOfSlot = element.parentNode;

            if (parentOfSlot) {
                if (providedContentFragment && providedContentFragment.childNodes.length > 0) {
                    // 插入父组件提供的、已在父组件上下文中编译好的插槽内容
                    parentOfSlot.insertBefore(providedContentFragment.cloneNode(true), element);
                } else {
                    // 使用后备内容
                    const fallbackFragment = document.createDocumentFragment();
                    while (element.firstChild) fallbackFragment.appendChild(element.firstChild); // 移动后备内容到 fragment
                    // 后备内容是在子组件的作用域和上下文中编译的
                    Array.from(fallbackFragment.childNodes).forEach((fallbackNode) => {
                        compileNode(fallbackNode, scope, directiveHandlers, `${parentComponentName} (slot '${slotName}' fallback)`, currentContextOriginalUrl);
                    });
                    parentOfSlot.insertBefore(fallbackFragment, element);
                }
                parentOfSlot.removeChild(element); // 移除 <slot> 标签本身
            } else {
                console.warn(`核心警告：[${parentComponentName}] <slot name="${slotName}"> 标签无父节点，无法渲染。`);
            }
            return; // <slot> 标签已处理
        }

        // 1.4 处理其他元素指令和属性绑定
        const attributesToRemoveAfterProcessing = [];
        for (const attr of Array.from(element.attributes)) {
            const attrName = attr.name;
            const attrValue = attr.value;
            if (attrName.startsWith(":")) {
                // 属性绑定
                if (directiveHandlers.handleAttributeBinding) directiveHandlers.handleAttributeBinding(element, attrName.substring(1), attrValue, scope, parentComponentName);
                attributesToRemoveAfterProcessing.push(attrName);
            } else if (attrName.startsWith("@")) {
                // 事件绑定
                const eventName = attrName.substring(1);
                element.addEventListener(eventName, (event) => {
                    try {
                        const context = Object.create(scope);
                        context.$event = event;
                        const result = directiveHandlers.evaluateExpression(attrValue, context);
                        // 如果表达式是函数名且求值结果是函数，则以scope为this调用
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
            // 其他普通属性保留在元素上
        }
        attributesToRemoveAfterProcessing.forEach((attrName) => element.removeAttribute(attrName));

        // 1.5 递归处理子节点 (传递 currentContextOriginalUrl)
        Array.from(element.childNodes).forEach((child) => compileNode(child, scope, directiveHandlers, `${parentComponentName} > ${element.tagName.toUpperCase()}`, currentContextOriginalUrl));
    }
    // 2. 处理文本节点 (插值)
    else if (node.nodeType === Node.TEXT_NODE) {
        const textContent = node.textContent || "";
        const mustacheRegex = /\{\{([^}]+)\}\}/g; // 正则匹配 {{ expression }}
        if (!mustacheRegex.test(textContent)) return; // 没有插值，直接返回

        const segments = []; // 存储文本片段和插值占位符
        let lastIndex = 0;
        let match;
        mustacheRegex.lastIndex = 0; // 重置正则的 lastIndex
        while ((match = mustacheRegex.exec(textContent)) !== null) {
            // 添加插值前的静态文本部分
            if (match.index > lastIndex) segments.push(document.createTextNode(textContent.substring(lastIndex, match.index)));

            const expression = match[1].trim(); // 获取 {{}} 中的表达式
            const placeholderNode = document.createTextNode(""); // 为动态内容创建占位文本节点
            segments.push(placeholderNode);

            // 创建副作用，当表达式依赖的 signal 变化时更新占位符内容
            createEffect(() => {
                try {
                    const value = directiveHandlers.evaluateExpression(expression, scope);
                    placeholderNode.textContent = value === undefined || value === null ? "" : String(value);
                } catch (error) {
                    console.error(`核心错误：[${parentComponentName}] 计算插值表达式 "{{${expression}}}" 出错:`, error);
                    placeholderNode.textContent = `{{表达式错误: ${expression}}}`;
                }
            });
            lastIndex = mustacheRegex.lastIndex; // 更新下次匹配的起始位置
        }
        // 添加最后一个插值后的静态文本部分
        if (lastIndex < textContent.length) segments.push(document.createTextNode(textContent.substring(lastIndex)));

        // 如果有动态片段，则替换原文本节点
        if (segments.length > 0 && node.parentNode) {
            segments.forEach((segment) => node.parentNode.insertBefore(segment, node));
            node.parentNode.removeChild(node); // 移除原始的包含 {{}} 的文本节点
        }
    }
}

/**
 * 将 CSS 样式注入到文档头部。
 * @param {string} css CSS 字符串
 * @param {string} originalComponentUrl 用于生成唯一 ID (不带版本号)，防止重复注入
 */
function injectStyles(css, originalComponentUrl) {
    if (!css || !css.trim()) return;
    // 使用不带版本号的原始 URL 生成 ID，确保版本更新不重复注入相同样式
    const styleId = `nono-style-${originalComponentUrl.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    if (document.getElementById(styleId)) return; // 防止重复注入

    const styleElement = document.createElement("style");
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
    if (node.nodeType === Node.ELEMENT_NODE) {
        // 只对元素节点操作
        // 递归清理子孙节点
        if (node.hasChildNodes()) {
            Array.from(node.childNodes).forEach((child) => cleanupAndRemoveNode(child));
        }
        // 执行当前节点的 onUnmount (如果已注册)
        const cleanupCallback = componentCleanupRegistry.get(node);
        if (typeof cleanupCallback === "function") {
            try {
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
 * 挂载组件到目标位置。(内部函数)
 * @param {string} versionedComponentUrl - 带版本号的组件 URL (用于加载和缓存key)。
 * @param {string | Element | Comment} target - CSS 选择器、目标元素或占位符注释节点。
 * @param {object} [initialProps={}] - 传递给组件的 Props。
 * @param {object} [eventHandlers={}] - 父组件提供的事件处理器。
 * @param {string} [componentName='组件'] - 组件名称，用于日志。
 * @param {object} [parsedSlots={}] - 父组件解析并编译好的插槽内容。
 * @param {string} originalAbsoluteUrl - 不带版本号的原始绝对URL，用于样式注入和作为子组件src解析基准。
 * @returns {Promise<Element | null>} 返回挂载的组件根元素，或在失败时返回 null。
 */
async function _mountComponentInternal(versionedComponentUrl, target, initialProps = {}, eventHandlers = {}, componentName = "组件", parsedSlots = {}, originalAbsoluteUrl) {
    console.log(`核心：开始挂载组件: ${componentName} (源: ${originalAbsoluteUrl}, 版本化URL: ${versionedComponentUrl})`);
    let targetElement = null;
    let isPlaceholder = false;

    // 解析挂载目标
    if (typeof target === "string") {
        targetElement = document.querySelector(target);
        if (!targetElement) {
            console.error(`核心错误：挂载失败，找不到目标元素 "${target}"`);
            return null;
        }
    } else if (target instanceof Element || target instanceof Comment) {
        targetElement = target;
        isPlaceholder = target instanceof Comment; // 检查是否是注释占位符
        if (isPlaceholder && !targetElement.parentNode) {
            // 占位符必须在 DOM 中
            console.error(`核心错误：挂载失败，注释占位符已脱离 DOM`);
            return null;
        }
    } else {
        // 无效目标
        console.error(`核心错误：挂载失败，无效的目标类型`, target);
        return null;
    }

    // 检查依赖
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
        // 1. 加载组件文本 (带缓存和并发处理)
        // originalAbsoluteUrl 用于在 fetchAndCacheComponentText 内部首次缓存时记录原始URL
        const componentText = await fetchAndCacheComponentText(versionedComponentUrl, originalAbsoluteUrl);

        // 获取缓存条目 (此时应已存在，由 fetchAndCacheComponentText 创建或确认)
        let cacheEntry = componentCache.get(versionedComponentUrl);
        if (!cacheEntry) {
            // 理论上不应发生
            console.error(`核心严重错误：组件 ${versionedComponentUrl} 文本已获取，但缓存条目丢失！将尝试重新创建。`);
            cacheEntry = { text: componentText, structure: null, ast: null, originalUrl: originalAbsoluteUrl };
            componentCache.set(versionedComponentUrl, cacheEntry);
        }

        // 2. 解析组件结构 (template, script, style) - 带缓存
        if (!cacheEntry.structure) {
            // 仅当未解析时才解析
            cacheEntry.structure = parseComponentStructure(componentText, versionedComponentUrl);
        }
        const { template, script, style } = cacheEntry.structure;

        // 3. 解析脚本 AST (带缓存)
        if (script.trim() && !cacheEntry.ast) {
            // 仅当有脚本且未解析时才解析
            cacheEntry.ast = parseScriptWithAcorn(script, versionedComponentUrl);
        }
        const ast = cacheEntry.ast;

        // 4. 创建 emit 函数并执行脚本获取作用域
        const emit = createEmitFunction(eventHandlers, componentName);
        const componentScope = executeScript(script, ast, initialProps, emit);
        if (componentScope && typeof componentScope === "object") {
            componentScope.$slots = parsedSlots; // 注入预编译的插槽内容
        } else {
            console.warn(`核心警告：组件 ${componentName} 的脚本未返回有效作用域，无法注入 $slots。`);
        }

        // 5. 编译模板
        const fragment = document.createDocumentFragment();
        const tempDiv = document.createElement("div"); // 使用临时 div 解析模板字符串
        tempDiv.innerHTML = template.trim(); // trim() 避免首尾空白文本节点
        while (tempDiv.firstChild) fragment.appendChild(tempDiv.firstChild); // 移动到 fragment

        const potentialRootElementInFragment = fragment.firstElementChild; // 记录可能的根元素

        // 编译时传递 originalAbsoluteUrl 作为子组件 src 解析的基准 URL
        Array.from(fragment.childNodes).forEach((node) => compileNode(node, componentScope, window.NueDirectives, componentName, originalAbsoluteUrl));

        // 6. 注入样式 (使用不带版本号的 originalAbsoluteUrl 生成 style ID)
        injectStyles(style, originalAbsoluteUrl);

        // 7. 挂载到 DOM
        let mountedRootElement = null;
        if (isPlaceholder) {
            // 替换占位符注释
            const parent = targetElement.parentNode;
            if (parent) {
                // 确保占位符仍在DOM中
                parent.insertBefore(fragment, targetElement);
                mountedRootElement = potentialRootElementInFragment; // 假设第一个元素是根
                parent.removeChild(targetElement); // 移除占位符
            }
        } else {
            // 替换目标元素内容
            cleanupAndRemoveNode(targetElement.firstChild); // 清理旧内容 (如果有)
            targetElement.innerHTML = ""; // 确保清空
            mountedRootElement = fragment.firstElementChild; // 假设第一个元素是根
            targetElement.appendChild(fragment);
        }

        // 8. 执行 onMount 生命周期钩子
        if (mountedRootElement && componentScope && typeof componentScope.onMount === "function") {
            try {
                componentScope.onMount();
            } catch (error) {
                console.error(`核心错误：执行 onMount 钩子时出错 (${componentName}):`, error);
            }
            // 注册 onUnmount (如果存在)
            if (typeof componentScope.onUnmount === "function") {
                componentCleanupRegistry.set(mountedRootElement, componentScope.onUnmount);
            }
        }

        console.log(`核心：组件 ${componentName} (${versionedComponentUrl}) 挂载完成.`);
        return mountedRootElement;
    } catch (error) {
        console.error(`核心错误：挂载组件 ${versionedComponentUrl} (源: ${originalAbsoluteUrl}) 失败:`, error);
        // 在目标位置显示错误信息
        if (targetElement instanceof Element && !isPlaceholder) {
            targetElement.innerHTML = `<p style="color:red;">组件 ${componentName} 加载或渲染失败。详情见控制台。</p>`;
        } else if (isPlaceholder && targetElement.parentNode) {
            // 如果是占位符，在其后插入错误文本
            const errorNode = document.createTextNode(` [组件 ${componentName} (源: ${originalAbsoluteUrl}) 渲染错误] `);
            targetElement.parentNode.insertBefore(errorNode, targetElement.nextSibling);
        }
        return null; // 返回 null 表示挂载失败
    }
}

/**
 * (内部或高级用法) 挂载组件到指定的 DOM 位置。
 * 对于常规应用启动，请优先使用 NueCore.init()。
 * 此函数主要用于框架内部（如子组件的动态挂载）或需要更细致控制挂载过程的场景。
 *
 * @param {string} componentFile - 组件的文件路径。
 *                                 如果这是顶层调用（非子组件），路径相对于当前HTML页面。
 *                                 如果是子组件通过 src 加载，路径已由 compileNode 解析。
 * @param {string | Element | Comment} targetSelectorOrElement - 挂载目标的 CSS 选择器、DOM 元素或注释占位符。
 * @param {object} [initialProps={}] - (可选) 传递给组件的初始 Props。
 * @param {object} [eventHandlers={}] - (内部使用) 父组件传递给子组件的事件处理器。
 * @param {string} [componentNameSuggestion] - (内部使用) 建议的组件名，用于日志。
 * @param {object} [parsedSlots={}] - (内部使用) 父组件提供的、已编译的插槽内容。
 * @param {string} [baseResolutionUrlOverride] - (内部使用) 覆盖用于解析组件URL的基准URL。
 *                                               主要用于确保顶层调用时，componentFile 相对于页面解析。
 *                                               对于子组件，这个通常是父组件的 originalUrl。
 * @returns {Promise<Element | null>} Promise 解析为挂载的组件根元素，或在失败时为 null。
 */
function mountComponent(
    componentFile,
    targetSelectorOrElement,
    initialProps = {},
    eventHandlers = {}, // 通常由 compileNode 内部为子组件提供
    componentNameSuggestion, // 通常由 compileNode 内部为子组件提供
    parsedSlots = {}, // 通常由 compileNode 内部为子组件提供
    baseResolutionUrlOverride, // 新增此参数，但对于外部调用通常为 undefined
) {
    // 1. 解析组件的 URL (带版本和不带版本)
    //    - baseResolutionUrlOverride: 如果提供，则以此为基准解析 componentFile。
    //      对于顶层调用 (来自 init 或直接调用 NueCore.mountComponent)，此参数应为 null 或 undefined，
    //      使得 componentFile 相对于当前页面 (window.location.href) 解析。
    //    - 如果是子组件的挂载 (由 compileNode 调用 _mountComponentInternal 进而可能间接调用此)，
    //      compileNode 会传递父组件的 originalUrl 作为解析基准。
    const { versionedUrl, originalUrl } = getVersionedAndOriginalUrls(componentFile, baseResolutionUrlOverride || null);

    // 2. 确定组件名 (用于日志)
    let finalComponentName = componentNameSuggestion;
    if (!finalComponentName) {
        // 如果没有建议的组件名 (通常是顶层调用)，从原始 URL 推断
        const nameParts = originalUrl.substring(originalUrl.lastIndexOf("/") + 1).split(".");
        finalComponentName = nameParts[0] || "组件"; // 如果文件名是 ".nue" 则用 "组件"
    }

    // 3. 调用真正的内部挂载函数
    //    注意：_mountComponentInternal 接收 versionedUrl 和 originalUrl 作为独立参数
    return _mountComponentInternal(
        versionedUrl,
        targetSelectorOrElement,
        initialProps,
        eventHandlers,
        finalComponentName,
        parsedSlots,
        originalUrl, // 传递原始绝对URL给内部函数，用于样式注入ID和子组件src解析基准
    );
}

// ==================================
// 4. 暴露核心 API
// ==================================
window.NueCore = {
    /**
     * 初始化 NueCore 框架并挂载根组件。
     * 这是推荐的应用启动方式。
     * @param {string} targetId - 根组件将要挂载到的 DOM 元素的 ID (不带 '#')。
     * @param {string} rootComponentFile - 根组件的文件路径 (例如 'app.nue' 或 './components/main.nue')。
     *                                   此路径将相对于当前 HTML 页面进行解析。
     * @param {string} [appVersion] - (可选) 应用的版本号，用于控制组件缓存。
     *                                当版本号改变时，组件URL会附加不同的查询参数 ('?v=版本号')，
     *                                使浏览器将它们视为新资源，从而更新HTTP缓存。
     *                                如果不提供，则组件加载时不附加版本参数。
     * @param {object} [initialProps={}] - (可选) 传递给根组件的初始 Props。
     * @returns {Promise<Element | null>} Promise 解析为挂载的组件根元素，或在失败时为 null。
     */
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
            console.log(`核心信息：应用版本号已设置为 "${NueCoreConfig.appVersion}".`);
        } else {
            NueCoreConfig.appVersion = null;
            if (appVersion !== undefined) {
                console.warn(`核心警告：提供的应用版本号无效，组件将不带版本参数加载。`);
            } else {
                console.log(`核心信息：未提供应用版本号，组件将不带版本参数加载。`);
            }
        }

        // 清理 localStorage 中与当前 appVersion 不匹配的旧组件缓存
        // 只有当 NueCoreConfig.appVersion 有效时才执行清理
        if (NueCoreConfig.appVersion) {
            cleanupOldLocalStorageCache();
        }

        const targetSelector = `#${targetId}`;
        return mountComponent(rootComponentFile, targetSelector, initialProps);
    },

    // 暴露其他核心功能 (保持不变)
    createSignal,
    createEffect,
    compileNode,
    cleanupAndRemoveNode,
};

console.log("nono-core.js 加载完成，NueCore 对象已准备就绪。");
