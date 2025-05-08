// nono-core.js - 优化版本
// 核心配置文件
const NueCoreConfig = {
    appVersion: null, // 应用版本号，用于缓存控制
};

// 全局变量，用于追踪当前正在执行的 effect 函数
let currentEffect = null;

/**
 * 创建一个响应式数据单元 (Signal)。
 * @param {*} initialValue - Signal 的初始值。
 * @returns {Function} 一个访问器函数。
 *                     调用时不带参数则获取值。
 *                     调用时带参数则设置值，并触发所有订阅此 Signal 的 effect。
 */
function createSignal(initialValue) {
    let value = initialValue;
    // 存储订阅此信号的 effect 函数实例。
    // effect 实例自身会持有对这个 Set 的引用，以便在清理时从中移除自己。
    const subscribers = new Set();

    function signalAccessor(newValue) {
        if (arguments.length === 0) {
            // 获取值
            if (currentEffect && currentEffect.isActive) {
                // 确保 effect 处于活动状态
                // 订阅：将当前 effect 添加到订阅者列表
                subscribers.add(currentEffect);
                // effect 也需要记录它订阅了哪些 signal 的 subscribers 集合，以便清理
                // currentEffect.dependencies 是在 createEffect 中定义的 Set
                currentEffect.dependencies.add(subscribers);
            }
            return value;
        } else {
            // 设置值
            if (value !== newValue) {
                value = newValue;
                // 复制订阅者集合进行迭代，以防在通知过程中集合被修改
                // （例如，某个 effect 在执行时又修改了其他 signal，导致 subscribers 变化）
                // 或者某个 effect 在执行时被清理掉。
                const effectsToRun = new Set(subscribers); // 创建副本
                effectsToRun.forEach((effectInstance) => {
                    // 确保 effect 仍然存在且处于活动状态
                    if (effectInstance && typeof effectInstance === "function" && effectInstance.isActive) {
                        effectInstance(); // 执行 effect 函数
                    } else if (!effectInstance.isActive) {
                        // 如果 effect 不再活动，从订阅者中移除 (可选的自动清理)
                        // subscribers.delete(effectInstance);
                    }
                });
            }
            return newValue; // 返回新设置的值
        }
    }
    return signalAccessor;
}

/**
 * 创建一个副作用函数 (Effect)，它会自动追踪其依赖的 Signal，
 * 并在这些 Signal 变化时重新执行。
 * @param {Function} fn - 包含响应式依赖的函数。
 * @returns {Function} 一个清理函数。调用此函数将停止 effect 的执行并清除其所有依赖。
 */
function createEffect(fn) {
    // effect 函数实例，它会被 Signal 订阅
    const effect = () => {
        if (!effect.isActive) {
            // 如果 effect 已被清理，则不执行
            return;
        }

        // 在执行用户传入的 fn 之前，清理此 effect 上一次运行时建立的所有依赖关系。
        // 这样可以确保依赖关系总是最新的，避免过时依赖。
        cleanupEffectDependencies(effect);

        // 设置全局的 currentEffect 为当前 effect 实例
        currentEffect = effect;
        // 初始化/重置当前 effect 的依赖集合 (存储的是 Signal 的 subscribers Set)
        effect.dependencies = new Set();

        try {
            fn(); // 执行用户传入的函数。在此期间，任何被访问的 Signal 都会将此 effect 添加到它们的 subscribers 中。
        } catch (error) {
            console.error("Error executing effect:", error);
        } finally {
            currentEffect = null; // 清理全局的 currentEffect
        }
    };

    // 给 effect 函数实例添加属性
    effect.isActive = true; // 标记 effect 是否处于活动状态
    effect.dependencies = new Set(); // 存储此 effect 依赖的所有 Signal 的 subscribers 集合

    // 内部函数，用于清理 effect 的所有依赖
    function cleanupEffectDependencies(effectInstance) {
        if (effectInstance.dependencies) {
            effectInstance.dependencies.forEach((signalSubscribersSet) => {
                // 从每个它曾订阅的 Signal 的 subscribers 集合中移除此 effect
                signalSubscribersSet.delete(effectInstance);
            });
            effectInstance.dependencies.clear(); // 清空 effect 自身的依赖记录
        }
    }

    // 首次立即执行 effect 以建立初始依赖
    try {
        effect();
    } catch (e) {
        console.error("Error during initial effect execution:", e);
    }

    // 返回一个清理函数
    const stopEffect = () => {
        if (effect.isActive) {
            cleanupEffectDependencies(effect); // 清理所有依赖
            effect.isActive = false; // 标记为非活动状态，阻止后续执行
            // console.log("Effect stopped and cleaned up."); // 调试信息
        }
    };

    return stopEffect;
}

/**
 * 监听一个 Signal 的变化，并在其值改变时执行回调函数。
 * @param {Function} signalToWatch - 由 createSignal 创建的响应式变量的访问器函数。
 * @param {Function} callback - 当 signalToWatch 的值变化时执行的回调函数。
 *                               接收两个参数: (newValue, oldValue)。
 * @param {object} [options] - 可选配置对象。
 * @param {boolean} [options.immediate=false] - 如果为 true，回调函数会在 watch 创建时立即执行一次（通过微任务）。
 *                                              此时，回调函数中的 oldValue 参数将是 undefined。
 * @returns {Function} 一个停止监听的函数。调用此函数将取消 watch。
 */
function createWatch(signalToWatch, callback, options = {}) {
    const { immediate = false } = options;

    let oldValue;
    let isInitialized = false;
    let pendingCallback = false; // 新增：防止微任务重复调度

    // 内部函数，用于安全地调度并执行回调
    const scheduleCallback = (newValue, oldValueForCallback) => {
        if (pendingCallback) return; // 如果已有回调在微任务队列中，则不再添加
        pendingCallback = true;
        queueMicrotask(() => { // 使用 queueMicrotask 延迟执行
            try {
                callback(newValue, oldValueForCallback);
            } catch (e) {
                console.error("Watch callback execution failed:", e);
            } finally {
                pendingCallback = false; // 执行完毕，允许下一次调度
            }
        });
    };

    const stop = createEffect(() => {
        const newValue = signalToWatch();

        if (!isInitialized) {
            oldValue = newValue;
            isInitialized = true;
            if (immediate) {
                // 立即执行选项：将首次回调放入微任务队列
                scheduleCallback(newValue, undefined);
            }
            return;
        }

        if (newValue !== oldValue) {
            // 值变化时：将回调放入微任务队列
            const previousOldValue = oldValue; // 捕获当前的 oldValue
            oldValue = newValue; // 更新 oldValue 以供下次比较
            scheduleCallback(newValue, previousOldValue); // 传递捕获的旧值
        }
    });

    return stop;
}

// 组件及模块相关缓存与注册表
const componentCache = new Map(); // 缓存组件文本、结构、AST: { versionedUrl -> { text, structure, ast, originalUrl } }
const _pendingRequests = new Map(); // 缓存正在进行的组件/NJS文件文本 fetch 请求: { versionedUrl -> Promise<text> }
const componentCleanupRegistry = new WeakMap(); // 存储组件卸载时的清理回调: { mountedRootElement -> onUnmountFunction }

// --- 新增: NJS 模块相关缓存 ---
// 键是版本化的 URL (versionedUrl)，值是 NJS 模块执行后返回的数据。
const njsModuleExecutionCache = new Map(); // 中文注释：NJS模块执行结果缓存
// 键是版本化的 URL (versionedUrl)，值是代表加载和执行 NJS 模块过程的 Promise。
// 用于确保对同一 NJS 模块的并发请求只执行一次加载和执行操作。
const _pendingNjsModuleLoads = new Map(); // 中文注释：进行中的NJS模块加载请求
// --- 结束新增 NJS 模块缓存 ---

// 辅助函数
const LOCAL_STORAGE_PREFIX = "nue_component_cache_"; // localStorage 键前缀

// 从 localStorage 获取缓存的组件/NJS文件文本
function getComponentFromLocalStorage(versionedUrl) {
    if (!NueCoreConfig.appVersion) {
        // 未设置版本号则不使用 localStorage
        return null;
    }
    const cacheKey = LOCAL_STORAGE_PREFIX + versionedUrl;
    try {
        const cachedItem = localStorage.getItem(cacheKey);
        if (cachedItem) {
            const { text, version } = JSON.parse(cachedItem);
            // 校验版本号是否匹配当前应用版本
            if (version === NueCoreConfig.appVersion && typeof text === "string") {
                return text; // 版本匹配，返回缓存的文本内容
            } else {
                localStorage.removeItem(cacheKey); // 版本不匹配或数据损坏，移除无效缓存
                return null;
            }
        }
    } catch (e) {
        console.warn(`核心警告：从 localStorage 读取资源 ${versionedUrl} 失败:`, e);
        try {
            localStorage.removeItem(cacheKey); // 尝试移除损坏的缓存项
        } catch (removeError) {
            /* 忽略移除错误 */
        }
        return null;
    }
    return null;
}

// 将组件/NJS文件文本存入 localStorage
function setComponentToLocalStorage(versionedUrl, text) {
    if (!NueCoreConfig.appVersion) {
        // 未设置版本号则不存入 localStorage
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
        // 捕获 localStorage 写满等错误
        console.warn(`核心警告：存入 localStorage 资源 ${versionedUrl} 失败 (可能已满):`, e);
    }
}

// 清理旧版本的 localStorage 缓存
function cleanupOldLocalStorageCache() {
    if (!NueCoreConfig.appVersion) return; // 没有版本号无法清理

    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith(LOCAL_STORAGE_PREFIX)) {
                try {
                    const item = localStorage.getItem(key);
                    if (item) {
                        const { version } = JSON.parse(item);
                        if (version !== NueCoreConfig.appVersion) {
                            // 版本不符则移除
                            localStorage.removeItem(key);
                            i--; // localStorage.length 会变化，调整索引
                        }
                    }
                } catch (e) {
                    // 解析错误或项不存在，也移除
                    localStorage.removeItem(key);
                    i--;
                }
            }
        }
    } catch (e) {
        console.warn("核心警告：清理旧 localStorage 缓存时出错:", e);
    }
}

// 解析 URL (相对路径转绝对路径)
function resolveUrl(relativeOrAbsoluteUrl, baseComponentUrl) {
    // 如果已经是绝对 URL (以 http/https 开头或 // 开头)
    if (/^(?:[a-z]+:)?\/\//i.test(relativeOrAbsoluteUrl)) {
        return new URL(relativeOrAbsoluteUrl, window.location.origin).href;
    }
    // 如果是以 / 开头的绝对路径 (相对于域名根)
    if (relativeOrAbsoluteUrl.startsWith("/")) {
        if (!relativeOrAbsoluteUrl.startsWith("//")) {
            // 确保不是 // 开头的协议相对 URL
            return new URL(relativeOrAbsoluteUrl, window.location.origin).href;
        }
    }
    // 处理相对路径
    try {
        const base = baseComponentUrl ? new URL(baseComponentUrl, window.location.origin) : new URL(window.location.href);
        return new URL(relativeOrAbsoluteUrl, base).href;
    } catch (e) {
        console.warn(`核心警告：解析 URL "${relativeOrAbsoluteUrl}" (基准: "${baseComponentUrl || window.location.href}") 失败，将按原样使用。错误:`, e);
        return relativeOrAbsoluteUrl; // 解析失败则返回原始路径
    }
}

// 获取版本化 URL 和原始绝对 URL
function getVersionedAndOriginalUrls(rawUrl, baseComponentUrlForResolution) {
    const originalAbsoluteUrl = resolveUrl(rawUrl, baseComponentUrlForResolution);
    let versionedUrl = originalAbsoluteUrl;
    if (NueCoreConfig.appVersion) {
        // 如果设置了应用版本号，则添加版本参数
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
// 解析 .nue 文件结构 (template, script, style)
function parseComponentStructure(text, versionedUrl) {
    const cached = componentCache.get(versionedUrl);
    if (cached && cached.structure) {
        // 优先从内存缓存获取
        return cached.structure;
    }

    let template = "";
    let script = "";
    let style = "";

    // 解析 <template>
    const firstTemplateStartTag = text.indexOf("<template");
    if (firstTemplateStartTag !== -1) {
        const firstTemplateStartTagEnd = text.indexOf(">", firstTemplateStartTag);
        if (firstTemplateStartTagEnd !== -1) {
            const lastTemplateEndTag = text.lastIndexOf("</template>");
            if (lastTemplateEndTag !== -1 && lastTemplateEndTag > firstTemplateStartTagEnd) {
                template = text.substring(firstTemplateStartTagEnd + 1, lastTemplateEndTag).trim();
            } else {
                // 回退到正则匹配 (容错)
                const templateMatchFallback = text.match(/<template\b[^>]*>([\s\S]*?)<\/template\s*>/i);
                template = templateMatchFallback ? templateMatchFallback[1].trim() : "";
            }
        }
    }

    // 解析 <script>
    const scriptMatch = text.match(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/i);
    script = scriptMatch ? scriptMatch[1].trim() : "";

    // 解析 <style>
    const styleMatch = text.match(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/i);
    style = styleMatch ? styleMatch[1].trim() : "";

    const structure = { template, script, style };
    if (cached) {
        // 存入内存缓存
        cached.structure = structure;
    }
    return structure;
}

// 使用 Acorn 解析脚本内容为 AST
function parseScriptWithAcorn(scriptContent, versionedUrl) {
    const cached = componentCache.get(versionedUrl);
    if (cached && cached.ast) {
        // 优先从内存缓存获取
        return cached.ast;
    }
    if (!window.acorn) {
        console.error("核心错误：Acorn 解析器 (acorn.js) 未加载！");
        return null;
    }
    try {
        const ast = acorn.parse(scriptContent, {
            ecmaVersion: 2020, // 支持较新的 JS 语法
            sourceType: "module", // 假设脚本是模块类型
            allowReturnOutsideFunction: true, // 允许在顶层使用 return (Nue 组件和 NJS 需要)
        });
        if (cached) {
            // 存入内存缓存
            cached.ast = ast;
        }
        return ast;
    } catch (error) {
        console.error(`核心错误：Acorn 解析脚本 (源: ${versionedUrl}) 失败:`, error);
        console.error("核心错误：问题脚本内容:\n", scriptContent);
        return null;
    }
}

// --- 新增: 内部函数，用于执行 NJS 脚本 (支持顶层 await) ---
// 这个函数负责实际运行 NJS 文件的 JavaScript 代码。
function _executeNjsScript(scriptContent, njsVersionedUrl, njsOriginalUrl) {
    // 参数:
    // scriptContent (string): NJS 文件的文本内容。
    // njsVersionedUrl (string): NJS 文件的版本化 URL，主要用于日志和调试。
    // njsOriginalUrl (string): NJS 文件的原始绝对 URL。这个非常重要，因为它将作为
    //                          此 NJS 文件内部任何 importNjs('./another.njs')调用的相对路径解析基准。

    if (!scriptContent.trim()) {
        // 如果脚本内容为空，则发出警告并返回一个解析为 undefined 的 Promise。
        console.warn(`核心警告：NJS 脚本 ${njsOriginalUrl} 内容为空，将返回 Promise<undefined>。`);
        return (async () => undefined)(); // 包装在 async IIFE 中以保持返回 Promise 的一致性
    }
    try {
        // 创建一个绑定了当前 NJS 文件原始 URL 的 importNjs 函数。
        // 当这个 NJS 脚本内部调用 importNjs 时，它会使用正确的基路径。
        const boundImportNjs = (relativePath) => {
            // _loadAndExecuteNjsModule 是实现 importNjs 功能的核心函数。
            return _loadAndExecuteNjsModule(relativePath, njsOriginalUrl);
        };

        // 将脚本内容包裹在异步立即执行函数表达式 (Async IIFE) 中
        // 这样脚本内部就可以使用顶层 await
        // Function 构造器执行后会返回这个 Async IIFE 的 Promise
        const njsFunction = new Function("importNjs", `return (async () => { ${scriptContent} })();`);
        // 调用构造出来的函数，并传入绑定的 importNjs 实现。
        const resultPromise = njsFunction(boundImportNjs);

        return resultPromise; // 返回由 Async IIFE 产生的 Promise
    } catch (error) {
        // 捕获 Function 构造器本身的同步错误（例如，如果脚本内容导致构造阶段的语法错误）
        console.error(`核心错误：构造 NJS 脚本执行函数 (源: ${njsOriginalUrl}, 版本化: ${njsVersionedUrl}) 时出错:`, error);
        console.error("核心错误：NJS 脚本内容:\n", scriptContent);
        // 返回一个立即 rejected 的 Promise，以便上层可以捕获
        return Promise.reject(error);
    }
}
// --- 结束新增 _executeNjsScript ---

// --- 新增: 核心的 NJS 加载和执行函数 (会被命名为 importNjs 并注入) ---
// 这个函数是实现 importNjs 功能的主体。
async function _loadAndExecuteNjsModule(relativePath, baseOriginalUrl) {
    // 参数:
    // relativePath (string): 需要加载的 NJS 文件的路径 (可以是相对路径或绝对路径)。
    // baseOriginalUrl (string): 调用 importNjs 的那个文件的原始绝对 URL。
    //                         对于 .nue 组件，这是组件文件的 URL。
    //                         对于 .njs 文件，这是该 .njs 文件的 URL。
    //                         此 URL 用于正确解析 relativePath。

    // 解析出版本化 URL (用于缓存键和网络请求) 和原始绝对 URL (用于日志和内部逻辑)。
    const { versionedUrl, originalUrl } = getVersionedAndOriginalUrls(relativePath, baseOriginalUrl);

    // 步骤 1: 检查 njsModuleExecutionCache 缓存 (内存中已执行的结果)。
    if (njsModuleExecutionCache.has(versionedUrl)) {
        return njsModuleExecutionCache.get(versionedUrl);
    }

    // 步骤 2: 检查 _pendingNjsModuleLoads 缓存 (进行中的加载请求)。
    if (_pendingNjsModuleLoads.has(versionedUrl)) {
        return _pendingNjsModuleLoads.get(versionedUrl);
    }

    // 步骤 3: 启动新的加载和执行过程。
    const loadPromise = (async () => {
        try {
            // 3.1 加载 NJS 文件的文本内容 (复用组件加载逻辑，支持 localStorage 缓存)。
            const scriptText = await fetchAndCacheComponentText(versionedUrl, originalUrl);

            // 3.2 执行 NJS 脚本。_executeNjsScript 返回一个 Promise。
            const executionResultPromise = _executeNjsScript(scriptText, versionedUrl, originalUrl);
            // 等待 NJS 脚本的 Async IIFE 完成 (脚本内部可能也有 await)。
            const finalModuleData = await executionResultPromise;

            // 3.3 将最终获取到的模块数据存入 njsModuleExecutionCache 缓存。
            njsModuleExecutionCache.set(versionedUrl, finalModuleData);
            return finalModuleData;
        } catch (error) {
            // 错误已在 _executeNjsScript 或 fetchAndCacheComponentText 中打印。
            // 这里再次抛出，以便调用 importNjs 的地方可以通过 .catch() 或 try-catch 来处理。
            console.error(`核心错误：NJS 模块 ${originalUrl} (版本化 URL: ${versionedUrl}) 的加载或执行流程失败。`);
            throw error;
        }
    })();

    // 将新的加载 Promise 存入进行中请求的缓存。
    _pendingNjsModuleLoads.set(versionedUrl, loadPromise);

    // 无论成功或失败，最终都从进行中请求的缓存中移除。
    loadPromise.finally(() => {
        _pendingNjsModuleLoads.delete(versionedUrl);
    });

    return loadPromise;
}
// --- 结束新增 NJS 加载执行函数 ---

// --- 修改 executeScript (用于 .nue 组件的 <script> 块) 以支持顶层 await ---
// 函数变为 async，因为它内部会 await 脚本执行的 Promise
async function executeScript(scriptContent, ast, initialProps = {}, emit = () => console.warn("核心警告：emit 函数未在执行脚本时提供"), componentOriginalUrl) {
    if (!scriptContent.trim()) {
        return {}; // 如果脚本为空，返回空作用域
    }
    // 如果脚本内容不为空，但 AST 解析失败 (ast 为 null)，则警告并返回空作用域
    if (ast === null && scriptContent.trim()) {
        console.warn(`核心警告：由于脚本解析失败 (源: ${componentOriginalUrl})，跳过执行。返回空作用域。`);
        return {};
    }
    try {
        // 为 .nue 组件脚本内部的 importNjs 调用创建一个特定于此组件的实例。
        // 当组件脚本中调用 importNjs('./module.njs') 时，路径会相对于该组件的 URL (componentOriginalUrl) 解析。
        const boundImportNjsForNue = (relativePath) => {
            return _loadAndExecuteNjsModule(relativePath, componentOriginalUrl);
        };

        // 准备传递给 Function 构造器的参数名列表和对应的参数值。
        // 新增了 'importNjs'。
        const scriptArgNames = ["createSignal", "createWatch", "props", "emit", "importNjs"];
        const scriptArgValues = [createSignal, createWatch, initialProps, emit, boundImportNjsForNue];

        // 将脚本内容包裹在异步立即执行函数表达式 (Async IIFE) 中，以支持顶层 await
        const wrappedScriptContent = `return (async () => { ${scriptContent} })();`;
        const scriptFunction = new Function(...scriptArgNames, wrappedScriptContent);

        // 执行脚本函数，并等待其 Promise 完成
        // scriptFunction(...) 返回的是 Async IIFE 的 Promise
        const componentScopePromise = scriptFunction(...scriptArgValues);
        const componentScope = await componentScopePromise;

        if (typeof componentScope === "object" && componentScope !== null) {
            return componentScope; // 脚本应返回一个对象作为其作用域
        } else {
            // 如果脚本未返回对象或返回 null，则警告并返回空作用域
            console.warn(`核心警告：组件脚本 (源: ${componentOriginalUrl}) 已执行，但未返回对象作为作用域。请确保脚本末尾有 'return { ... };'。返回空作用域。`);
            return {};
        }
    } catch (error) {
        // 捕获脚本执行期间的错误 (包括 Async IIFE 内部的未捕获错误)
        // 或 Function 构造器本身的同步错误
        console.error(`核心错误：执行组件脚本 (源: ${componentOriginalUrl}) 时出错:`, error);
        console.error("核心错误：脚本内容:\n", scriptContent);
        return {}; // 出错时返回空作用域
    }
}
// --- 结束修改 executeScript ---

// 创建 emit 函数，用于子组件向父组件发送事件
function createEmitFunction(eventHandlers, componentName = "子组件") {
    return function emit(eventName, payload) {
        const handler = eventHandlers[eventName];
        if (handler && typeof handler === "function") {
            try {
                handler(payload); // 执行父组件传递过来的事件处理器
            } catch (error) {
                console.error(`核心错误：执行 ${componentName} 的事件 "${eventName}" 处理器时出错:`, error);
            }
        }
    };
}

// 将短横线命名 (kebab-case) 转换为驼峰命名 (camelCase)
function kebabToCamel(kebabCase) {
    return kebabCase.replace(/-([a-z])/g, (match, letter) => letter.toUpperCase());
}

// 获取并缓存组件/NJS文件文本内容 (网络或 localStorage)
async function fetchAndCacheComponentText(versionedUrl, originalAbsoluteUrl) {
    // 尝试从 localStorage 获取
    const localStorageText = getComponentFromLocalStorage(versionedUrl);
    if (localStorageText !== null) {
        if (!componentCache.has(versionedUrl)) {
            // 更新内存缓存
            componentCache.set(versionedUrl, { text: localStorageText, structure: null, ast: null, originalUrl: originalAbsoluteUrl });
        } else {
            componentCache.get(versionedUrl).text = localStorageText;
        }
        return localStorageText;
    }

    // 尝试从内存缓存获取 (如果 localStorage 未命中或禁用)
    const memoryCached = componentCache.get(versionedUrl);
    if (memoryCached && memoryCached.text) {
        return memoryCached.text;
    }

    // 如果有正在进行的 fetch 请求，则返回该请求的 Promise
    if (_pendingRequests.has(versionedUrl)) {
        return _pendingRequests.get(versionedUrl);
    }

    // 发起新的 fetch 请求
    const fetchPromise = fetch(versionedUrl)
        .then((response) => {
            if (!response.ok) {
                throw new Error(`加载资源 ${versionedUrl} 失败: ${response.status} ${response.statusText}`);
            }
            return response.text();
        })
        .then((text) => {
            // 成功获取后，存入内存缓存和 localStorage
            componentCache.set(versionedUrl, { text, structure: null, ast: null, originalUrl: originalAbsoluteUrl });
            setComponentToLocalStorage(versionedUrl, text);
            _pendingRequests.delete(versionedUrl); // 从挂起请求中移除
            return text;
        })
        .catch((error) => {
            _pendingRequests.delete(versionedUrl); // 请求失败也从挂起中移除
            console.error(`核心错误：获取资源 ${versionedUrl} 文本失败:`, error);
            throw error; // 重新抛出错误
        });

    _pendingRequests.set(versionedUrl, fetchPromise); // 将新的 fetch Promise 存入挂起请求
    return fetchPromise;
}

// 编译 DOM 节点 (处理指令、插值、子组件、插槽等)
function compileNode(node, scope, directiveHandlers, parentComponentName = "根组件", currentContextOriginalUrl = null) {
    // 确认指令处理器和其核心方法已准备好
    if (!directiveHandlers || typeof directiveHandlers.evaluateExpression !== "function") {
        console.error(`核心错误：[${parentComponentName}] 指令处理器或 evaluateExpression 未准备好，编译中止。`);
        return;
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node;
        const tagName = element.tagName.toLowerCase();

        // --- 处理子组件 ---
        if (tagName.includes("-") && !["template", "script", "style", "slot"].includes(tagName)) {
            const srcAttr = element.getAttribute("src");
            const rawComponentPath = srcAttr ? srcAttr : `${tagName}.nue`; // 组件路径
            // 解析子组件 URL，currentContextOriginalUrl 是当前编译上下文的 URL (父组件或NJS的URL)
            const { versionedUrl: childVersionedUrl, originalUrl: childOriginalUrl } = getVersionedAndOriginalUrls(rawComponentPath, currentContextOriginalUrl);

            const initialProps = {}; // 传递给子组件的 props
            const eventHandlers = {}; // 子组件事件的处理器
            const attributesToRemove = []; // 处理完后需移除的属性

            // 遍历属性，处理 props 和事件绑定
            for (const attr of Array.from(element.attributes)) {
                const attrName = attr.name;
                const attrValue = attr.value;

                if (attrName === "src") {
                    // src 已用于路径，应移除
                    attributesToRemove.push(attrName);
                    continue;
                }

                if (attrName.startsWith(":")) {
                    // 动态 prop
                    const rawPropName = attrName.substring(1);
                    const camelCasePropName = kebabToCamel(rawPropName);
                    const expression = attrValue;
                    const propSignal = createSignal(undefined); // 为动态 prop 创建 signal
                    createEffect(() => {
                        // 监听表达式变化并更新 propSignal
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
                    // 事件绑定
                    const eventName = attrName.substring(1);
                    const handlerExpression = attrValue;
                    eventHandlers[eventName] = (payload) => {
                        // 创建事件处理器
                        try {
                            const context = Object.create(scope);
                            context.$event = payload; // 将 $event 注入事件处理上下文
                            const result = directiveHandlers.evaluateExpression(handlerExpression, context);
                            // 如果表达式是简单方法名且结果是函数，则以父组件作用域为 this 调用
                            if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(handlerExpression.trim()) && typeof result === "function") {
                                result.call(scope, payload);
                            }
                        } catch (error) {
                            console.error(`核心错误：[${parentComponentName}] 执行子组件事件处理器 "${handlerExpression}" 出错:`, error);
                        }
                    };
                    attributesToRemove.push(attrName);
                } else {
                    // 静态 prop
                    initialProps[kebabToCamel(attrName)] = attrValue;
                }
            }

            // --- 处理插槽内容 ---
            const parsedSlots = {}; // 存储编译后的插槽内容片段
            const slotContentContainer = document.createDocumentFragment();
            const tempChildNodes = Array.from(element.childNodes); // 复制子节点列表
            tempChildNodes.forEach((cn) => slotContentContainer.appendChild(cn)); // 移到临时容器

            const rawSlotContents = { default: [] }; // 存储原始插槽节点
            Array.from(slotContentContainer.childNodes).forEach((childNode) => {
                // 区分具名和默认插槽
                if (childNode.nodeType === Node.ELEMENT_NODE && childNode.tagName.toLowerCase() === "template") {
                    if (childNode.hasAttribute("slot")) {
                        let slotNameAttr = (childNode.getAttribute("slot") || "").trim();
                        if (!slotNameAttr) slotNameAttr = "default"; // 空 slot 名视为默认

                        if (!rawSlotContents[slotNameAttr]) rawSlotContents[slotNameAttr] = [];
                        const templateContent = childNode.content; // <template> 的 DocumentFragment 内容
                        if (templateContent) Array.from(templateContent.childNodes).forEach((c) => rawSlotContents[slotNameAttr].push(c.cloneNode(true)));
                    } else {
                        // 无 slot 属性的 <template> 内容也视为默认插槽
                        const templateContent = childNode.content;
                        if (templateContent) Array.from(templateContent.childNodes).forEach((c) => rawSlotContents.default.push(c.cloneNode(true)));
                    }
                } else if (!(childNode.nodeType === Node.TEXT_NODE && childNode.nodeValue.trim() === "")) {
                    rawSlotContents.default.push(childNode.cloneNode(true)); // 其他非空节点为默认插槽
                }
            });

            // 编译每个插槽的原始内容 (在父组件作用域下)
            for (const sName in rawSlotContents) {
                const compiledSlotFragment = document.createDocumentFragment();
                if (rawSlotContents[sName].length > 0) {
                    rawSlotContents[sName].forEach((n) => compiledSlotFragment.appendChild(n));
                    // currentContextOriginalUrl 仍是父组件的 URL
                    Array.from(compiledSlotFragment.childNodes).forEach((nodeToCompile) => {
                        compileNode(nodeToCompile, scope, directiveHandlers, `${parentComponentName} (slot '${sName}')`, currentContextOriginalUrl);
                    });
                }
                parsedSlots[sName] = compiledSlotFragment; // 存储编译好的插槽
            }

            attributesToRemove.forEach((attrName) => element.removeAttribute(attrName)); // 移除已处理属性
            const placeholder = document.createComment(`component-placeholder: ${tagName}`); // 子组件占位符
            if (!element.parentNode) {
                console.error(`核心错误：[${parentComponentName}] 子组件 <${tagName}> 在替换为占位符前已无父节点。`);
                return;
            }
            element.parentNode.replaceChild(placeholder, element); // 用占位符替换原子组件标签

            // 异步挂载子组件
            mountComponent(
                childVersionedUrl, // 使用版本化 URL
                placeholder, // 挂载目标是占位符
                initialProps,
                eventHandlers,
                tagName, // 组件名提示
                parsedSlots,
                childOriginalUrl, // 子组件的原始 URL，用于其内部路径解析
            ).catch((error) => console.error(`核心错误：[${parentComponentName}] 异步挂载子组件 <${tagName}> (${childVersionedUrl}) 失败:`, error));
            return; // 子组件已处理
        }

        // --- 处理内置指令 (n-if, n-for 优先) ---
        const nIfAttr = element.getAttribute("n-if");
        if (nIfAttr !== null) {
            directiveHandlers.handleNIf(element, nIfAttr, scope, (node, s, dh, cn) => compileNode(node, s, dh, cn, currentContextOriginalUrl), directiveHandlers, parentComponentName);
            return; // n-if 控制整个元素渲染
        }
        const nForAttr = element.getAttribute("n-for");
        if (nForAttr !== null) {
            directiveHandlers.handleNFor(element, nForAttr, scope, (node, s, dh, cn) => compileNode(node, s, dh, cn, currentContextOriginalUrl), directiveHandlers, parentComponentName);
            return; // n-for 处理元素重复渲染
        }

        // --- 处理 <slot> 标签 ---
        if (tagName === "slot") {
            const slotName = element.getAttribute("name") || "default"; // 插槽名
            // 从作用域获取父组件提供的插槽内容 ($slots 由框架在子组件作用域中设置)
            const providedContentFragment = scope.$slots && scope.$slots[slotName];
            const parentOfSlot = element.parentNode;

            if (parentOfSlot) {
                if (providedContentFragment && providedContentFragment.childNodes.length > 0) {
                    // 插入父组件提供的已编译内容
                    parentOfSlot.insertBefore(providedContentFragment.cloneNode(true), element);
                } else {
                    // 渲染 <slot> 标签的后备内容
                    const fallbackFragment = document.createDocumentFragment();
                    while (element.firstChild) fallbackFragment.appendChild(element.firstChild);
                    // 编译后备内容 (在当前子组件作用域下)
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

        // --- 处理其他属性指令 ---
        const attributesToRemoveAfterProcessing = [];
        for (const attr of Array.from(element.attributes)) {
            const attrName = attr.name;
            const attrValue = attr.value;
            if (attrName.startsWith(":")) {
                // 动态属性绑定
                if (directiveHandlers.handleAttributeBinding) directiveHandlers.handleAttributeBinding(element, attrName.substring(1), attrValue, scope, parentComponentName);
                attributesToRemoveAfterProcessing.push(attrName);
            } else if (attrName.startsWith("@")) {
                // DOM 事件绑定
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
        attributesToRemoveAfterProcessing.forEach((attrName) => element.removeAttribute(attrName)); // 移除已处理指令属性

        // 递归编译当前元素的子节点
        Array.from(element.childNodes).forEach((child) => compileNode(child, scope, directiveHandlers, `${parentComponentName} > ${element.tagName.toUpperCase()}`, currentContextOriginalUrl));
    } else if (node.nodeType === Node.TEXT_NODE) {
        // 处理文本节点中的插值 {{ ... }}
        const textContent = node.textContent || "";
        const mustacheRegex = /\{\{([^}]+)\}\}/g; // 匹配 {{ expression }}
        if (!mustacheRegex.test(textContent)) return; // 无插值则不处理

        const segments = []; // 存储文本片段和插值占位符
        let lastIndex = 0;
        let match;
        mustacheRegex.lastIndex = 0; // 重置正则 lastIndex
        while ((match = mustacheRegex.exec(textContent)) !== null) {
            // 分割文本
            if (match.index > lastIndex) {
                // 表达式前的普通文本
                segments.push(document.createTextNode(textContent.substring(lastIndex, match.index)));
            }
            const expression = match[1].trim(); // 提取表达式
            const placeholderNode = document.createTextNode(""); // 为表达式结果创建占位文本节点
            segments.push(placeholderNode);

            createEffect(() => {
                // 监听表达式依赖变化并更新占位符
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
            // 表达式后的剩余普通文本
            segments.push(document.createTextNode(textContent.substring(lastIndex)));
        }

        // 用新片段替换原始文本节点
        if (segments.length > 0 && node.parentNode) {
            segments.forEach((segment) => node.parentNode.insertBefore(segment, node));
            node.parentNode.removeChild(node);
        }
    }
}

// 注入组件样式到文档头部
function injectStyles(css, originalComponentUrl) {
    if (!css || !css.trim()) return;
    // 基于组件 URL 创建唯一 ID，防重复注入
    const styleId = `nono-style-${originalComponentUrl.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    if (document.getElementById(styleId)) return; // 已存在则不重复注入

    const styleElement = document.createElement("style");
    styleElement.id = styleId;
    styleElement.textContent = css;
    document.head.appendChild(styleElement);
}

// 清理节点及其子孙节点，并执行卸载回调
function cleanupAndRemoveNode(node) {
    if (!node) return;

    if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.hasChildNodes()) {
            // 递归清理子节点
            Array.from(node.childNodes).forEach((child) => cleanupAndRemoveNode(child));
        }
        // 执行卸载回调 (onUnmount)
        const cleanupCallback = componentCleanupRegistry.get(node);
        if (typeof cleanupCallback === "function") {
            try {
                cleanupCallback();
            } catch (error) {
                console.error(`核心错误：执行 onUnmount 钩子时出错 (元素: ${node.tagName}):`, error);
            }
            componentCleanupRegistry.delete(node); // 移除回调
        }
    }
    // 从 DOM 中移除节点
    if (node.parentNode) {
        node.parentNode.removeChild(node);
    }
}

// 内部组件挂载函数
async function _mountComponentInternal(versionedComponentUrl, target, initialProps = {}, eventHandlers = {}, componentName = "组件", parsedSlots = {}, originalAbsoluteUrl) {
    let targetElement = null; // 挂载的目标 DOM 元素
    let isPlaceholder = false; // 标记 target 是否为注释占位符

    // 解析挂载目标
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
            // 占位符已脱离 DOM
            console.error(`核心错误：挂载失败，注释占位符已脱离 DOM`);
            return null;
        }
    } else {
        console.error(`核心错误：挂载失败，无效的目标类型`, target);
        return null;
    }

    // 检查依赖项 (Acorn, 指令处理器)
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
        // 1. 获取组件文本内容
        const componentText = await fetchAndCacheComponentText(versionedComponentUrl, originalAbsoluteUrl);
        let cacheEntry = componentCache.get(versionedComponentUrl);
        if (!cacheEntry) {
            // 理论上 fetchAndCacheComponentText 会创建缓存
            console.error(`核心严重错误：组件 ${versionedComponentUrl} 文本已获取，但缓存条目丢失！将尝试重新创建。`);
            cacheEntry = { text: componentText, structure: null, ast: null, originalUrl: originalAbsoluteUrl };
            componentCache.set(versionedComponentUrl, cacheEntry);
        }

        // 2. 解析组件结构
        if (!cacheEntry.structure) {
            cacheEntry.structure = parseComponentStructure(componentText, versionedComponentUrl);
        }
        const { template, script, style } = cacheEntry.structure;

        // 3. 解析脚本 AST
        if (script.trim() && !cacheEntry.ast) {
            cacheEntry.ast = parseScriptWithAcorn(script, versionedComponentUrl);
        }
        const ast = cacheEntry.ast;

        // 4. 执行组件脚本，获取作用域 (executeScript 现在是 async)
        const emit = createEmitFunction(eventHandlers, componentName);
        // 传递 originalAbsoluteUrl 作为组件脚本的基准 URL (用于其内部 importNjs)
        const componentScope = await executeScript(script, ast, initialProps, emit, originalAbsoluteUrl);

        // 将解析好的插槽内容 ($slots) 注入到组件作用域
        if (componentScope && typeof componentScope === "object") {
            componentScope.$slots = parsedSlots;
        } else {
            if (componentScope) {
                // 确保 componentScope 不是 null/undefined
                console.warn(`核心警告：组件 ${componentName} 的脚本未返回有效作用域对象，无法注入 $slots。实际返回:`, componentScope);
            }
        }

        // 5. 创建组件的 DOM 片段
        const fragment = document.createDocumentFragment();
        const tempDiv = document.createElement("div");
        tempDiv.innerHTML = template.trim();
        while (tempDiv.firstChild) fragment.appendChild(tempDiv.firstChild);

        const potentialRootElementInFragment = fragment.firstElementChild; // 可能的根元素

        // 6. 编译 DOM 片段 (originalAbsoluteUrl 作为当前编译上下文的 URL)
        Array.from(fragment.childNodes).forEach((node) => compileNode(node, componentScope, window.NueDirectives, componentName, originalAbsoluteUrl));

        // 7. 注入组件样式
        injectStyles(style, originalAbsoluteUrl);

        // 8. 挂载到目标位置
        let mountedRootElement = null;
        if (isPlaceholder) {
            // 目标是注释占位符
            const parent = targetElement.parentNode;
            if (parent) {
                parent.insertBefore(fragment, targetElement);
                mountedRootElement = potentialRootElementInFragment;
                parent.removeChild(targetElement); // 移除占位符
            }
        } else {
            // 目标是普通元素
            cleanupAndRemoveNode(targetElement.firstChild); // 清理旧内容
            targetElement.innerHTML = ""; // 确保清空
            mountedRootElement = fragment.firstElementChild;
            targetElement.appendChild(fragment);
        }

        // 9. 执行 onMount 生命周期钩子
        if (mountedRootElement && componentScope && typeof componentScope.onMount === "function") {
            try {
                await componentScope.onMount(); // onMount 自身可以是 async
            } catch (error) {
                console.error(`核心错误：执行 onMount 钩子时出错 (${componentName}):`, error);
            }
            // 注册 onUnmount 钩子
            if (typeof componentScope.onUnmount === "function") {
                componentCleanupRegistry.set(mountedRootElement, componentScope.onUnmount);
            }
        }
        return mountedRootElement; // 返回挂载的根元素
    } catch (error) {
        console.error(`核心错误：挂载组件 ${versionedComponentUrl} (源: ${originalAbsoluteUrl}) 失败:`, error);
        // 在目标位置显示错误信息
        if (targetElement instanceof Element && !isPlaceholder) {
            targetElement.innerHTML = `<p style="color:red;">组件 ${componentName} 加载或渲染失败。详情见控制台。</p>`;
        } else if (isPlaceholder && targetElement.parentNode) {
            const errorNode = document.createTextNode(` [组件 ${componentName} (源: ${originalAbsoluteUrl}) 渲染错误] `);
            targetElement.parentNode.insertBefore(errorNode, targetElement.nextSibling);
        }
        return null;
    }
}

// 公开的组件挂载函数
function mountComponent(
    componentFile, // 要挂载的组件文件路径
    targetSelectorOrElement, // 挂载目标
    initialProps = {}, // 初始 props
    eventHandlers = {}, // (子组件用) 事件处理器
    componentNameSuggestion, // (子组件用) 组件名提示
    parsedSlots = {}, // (子组件用) 已编译插槽
    baseResolutionUrlOverride, // (子组件用) 路径解析基准 URL
) {
    // 解析组件文件的版本化 URL 和原始绝对 URL
    const { versionedUrl, originalUrl } = getVersionedAndOriginalUrls(componentFile, baseResolutionUrlOverride || null);

    // 确定组件名
    let finalComponentName = componentNameSuggestion;
    if (!finalComponentName) {
        // 通常是根组件
        const nameParts = originalUrl.substring(originalUrl.lastIndexOf("/") + 1).split(".");
        finalComponentName = nameParts[0] || "组件";
    }

    // 调用内部挂载函数
    return _mountComponentInternal(
        versionedUrl,
        targetSelectorOrElement,
        initialProps,
        eventHandlers,
        finalComponentName,
        parsedSlots,
        originalUrl, // 传递原始绝对 URL
    );
}

// 暴露核心 API 到 window.NueCore
window.NueCore = {
    init: function (targetId, rootComponentFile, appVersion, initialProps = {}) {
        // 参数校验
        if (typeof targetId !== "string" || !targetId.trim()) {
            console.error("核心错误：NueCore.init() 的第一个参数 targetId 必须是一个有效的非空字符串 (DOM 元素 ID)。");
            return Promise.resolve(null);
        }
        if (typeof rootComponentFile !== "string" || !rootComponentFile.trim()) {
            console.error("核心错误：NueCore.init() 的第二个参数 rootComponentFile 必须是一个有效的非空字符串 (组件路径)。");
            return Promise.resolve(null);
        }

        // 设置应用版本号
        if (appVersion && typeof appVersion === "string" && appVersion.trim()) {
            NueCoreConfig.appVersion = appVersion.trim();
        } else {
            NueCoreConfig.appVersion = null;
            if (appVersion !== undefined) {
                console.warn(`核心警告：提供的应用版本号无效，组件将不带版本参数加载，localStorage 缓存将不基于版本。`);
            }
        }

        // 清理旧版本 localStorage 缓存 (如果启用了版本控制)
        if (NueCoreConfig.appVersion) {
            cleanupOldLocalStorageCache();
        }

        const targetSelector = `#${targetId}`; // 构建目标选择器
        // 挂载根组件
        return mountComponent(rootComponentFile, targetSelector, initialProps);
    },
    // 暴露 Signal 系统
    createSignal,
    createEffect,
    // 暴露编译和清理函数 (可能用于高级场景或指令系统)
    compileNode,
    cleanupAndRemoveNode,
    // 注意: importNjs 函数不在这里全局暴露，它是在脚本执行时通过闭包和 Function 构造器注入的。
};
