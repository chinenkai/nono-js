// nono-core.js - 优化版本

// 核心配置文件
const NueCoreConfig = {
    appVersion: null, // 应用版本号，用于缓存控制
};

/**
 * @const {string} __NUE_CONFUSION_KEY__
 * 用于文本混淆的密钥。
 * 重要提示：此密钥将包含在客户端代码中，因此仅用于轻量级混淆，并非强加密。
 */
const __NUE_CONFUSION_KEY__ = "NueJS-is-Awesome-And-Secret-!@#$%^"; // 你可以选择一个更复杂的密钥

/**
 * 对文本进行简单的异或 (XOR) 转换，用于混淆或解混淆。
 * @param {string} text - 需要转换的文本。
 * @param {string} key - 用于转换的密钥。
 * @returns {string} 转换后的文本。如果输入为空或转换出错，则可能返回原始文本。
 */
function nueSimpleTransform(text, key) {
    if (!text || !key) {
        // 如果文本或密钥为空，直接返回文本
        // console.warn("[NueCore] 文本转换：文本或密钥为空。");
        return text;
    }
    let result = "";
    try {
        for (let i = 0; i < text.length; i++) {
            // 将文本字符的 Unicode 码与密钥对应字符的 Unicode 码进行异或操作
            result += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
        }
    } catch (e) {
        // 如果在转换过程中发生错误（例如，处理非常规字符时），记录错误并返回原始文本
        console.error("[NueCore] 文本转换时发生错误:", e, "将返回原始文本。");
        return text;
    }
    return result;
}

// 全局变量，用于追踪当前正在执行的 effect 函数
let currentEffect = null;

// --- Effect 自动清理机制相关 ---
// _currentEffectCleanupList: 一个临时的数组，用于在特定组件挂载期间收集该组件内部创建的 Effect 的清理函数。
// 当一个组件开始挂载 (在 mountComponent 内部，执行其脚本之前)，这个变量会被设置为一个新的空数组。
// 在该组件脚本执行期间，任何通过 createEffect (或间接通过 createWatch) 创建的 Effect，
// 其返回的清理函数 (stopEffect) 都会被添加到这个数组中。
// 组件挂载流程结束后 (或出错时在 finally 块中)，这个变量会被恢复到它之前的值 (通常是 null 或父组件的列表)。
let _currentEffectCleanupList = null;

// componentEffectsRegistry: 一个 WeakMap，用于存储组件实例与其自动管理的 Effect 清理函数之间的映射。
// 键 (Key): 组件成功挂载后，其在 DOM 中的根元素 (mountedRootElement)。使用 WeakMap 是因为当组件根元素被垃圾回收时，
//           相关的 Effect 清理函数集合也应该能被自动回收，避免内存泄漏。
// 值 (Value): 一个 Set 集合，包含所有在该组件内部创建并需要自动清理的 Effect 的 stop 函数。
//           当组件被卸载时 (通过 cleanupAndRemoveNode)，框架会查找此注册表，
//           并执行与该组件根元素关联的所有 stop 函数，以停止这些 Effect 并释放其资源。
const componentEffectsRegistry = new WeakMap();
// --- 结束 Effect 自动清理机制相关 ---

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
                subscribers.add(currentEffect); // 订阅：将当前 effect 添加到订阅者列表
                // effect 也需要记录它订阅了哪些 signal 的 subscribers 集合，以便清理
                currentEffect.dependencies.add(subscribers);
            }
            return value;
        } else {
            // 设置值
            if (value !== newValue) {
                value = newValue;
                // 复制订阅者集合进行迭代，以防在通知过程中集合被修改
                // (例如，某个 effect 在执行时又修改了其他 signal，导致 subscribers 变化，或某个 effect 在执行时被清理掉)
                const effectsToRun = new Set(subscribers); // 创建副本
                effectsToRun.forEach((effectInstance) => {
                    // 确保 effect 仍然存在且处于活动状态
                    if (effectInstance && typeof effectInstance === "function" && effectInstance.isActive) {
                        effectInstance(); // 执行 effect 函数
                    }
                    // 可选：如果 effect 不再活动，可以考虑从订阅者中移除，但这通常由 effect 自身的清理逻辑处理
                    // else if (!effectInstance.isActive) {
                    //     subscribers.delete(effectInstance);
                    // }
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

        // 在执行用户传入的 fn 之前，清理此 effect 上一次运行时建立的所有依赖关系，
        // 这样可以确保依赖关系总是最新的，避免过时依赖。
        cleanupEffectDependencies(effect);

        currentEffect = effect; // 设置全局的 currentEffect 为当前 effect 实例
        effect.dependencies = new Set(); // 初始化/重置当前 effect 的依赖集合 (存储的是 Signal 的 subscribers Set)

        try {
            fn(); // 执行用户传入的函数。在此期间，任何被访问的 Signal 都会将此 effect 添加到它们的 subscribers 中。
        } catch (error) {
            console.error("Error executing effect:", error);
        } finally {
            currentEffect = null; // 清理全局的 currentEffect
        }
    };

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

    // 返回一个清理函数
    const stopEffect = () => {
        if (effect.isActive) {
            cleanupEffectDependencies(effect); // 清理所有依赖
            effect.isActive = false; // 标记为非活动状态，阻止后续执行
        }
    };

    // 如果 _currentEffectCleanupList 当前是一个有效的数组 (意味着正处于某个组件的挂载/脚本执行上下文中)，
    // 则将此 effect 的清理函数 stopEffect 添加到该列表中。
    // 这样，当该组件被卸载时，框架可以自动调用这些 stopEffect 函数。
    if (_currentEffectCleanupList && Array.isArray(_currentEffectCleanupList)) {
        _currentEffectCleanupList.push(stopEffect);
    }

    // 首次立即执行 effect 以建立初始依赖
    try {
        effect();
    } catch (e) {
        console.error("Error during initial effect execution:", e);
    }

    return stopEffect;
}

// 兼容queueMicrotask
if (typeof queueMicrotask !== "function") {
    window.queueMicrotask = function (cb) {
        Promise.resolve().then(cb);
    };
}

/**
 * 监听一个 Signal 的变化，并在其值改变时执行回调函数。
 * @param {Function} signalToWatch - 由 createSignal 创建的响应式变量的访问器函数。
 * @param {Function} callback - 当 signalToWatch 的值变化时执行的回调函数。接收两个参数: (newValue, oldValue)。
 * @param {object} [options={}] - 可选配置对象。
 * @param {boolean} [options.immediate=false] - 如果为 true，回调函数会在 watch 创建时立即执行一次（通过微任务）。此时，回调函数中的 oldValue 参数将是 undefined。
 * @returns {Function} 一个停止监听的函数。调用此函数将取消 watch。
 */
function createWatch(signalToWatch, callback, options = {}) {
    const { immediate = false } = options;

    let oldValue;
    let isInitialized = false;
    let pendingCallback = false; // 防止微任务重复调度

    // 内部函数，用于安全地调度并执行回调
    const scheduleCallback = (newValue, oldValueForCallback) => {
        if (pendingCallback) return; // 如果已有回调在微任务队列中，则不再添加
        pendingCallback = true;
        queueMicrotask(() => {
            // 使用 queueMicrotask 延迟执行
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

// === 路由功能开始 ===

// 辅助函数：获取当前浏览器地址的相关部分 (pathname + search + hash)
function _getCurrentLocationString() {
    return window.location.pathname + window.location.search + window.location.hash;
}

// 全局 Signal，用于存储和响应当前 URL 字符串的变化
// 它在 NueCore 对象定义之前声明，因为它会被 createUrlWatch 和事件监听器使用
const _currentUrlSignal = createSignal(_getCurrentLocationString()); // 使用已有的 createSignal

// 辅助函数：更新 _currentUrlSignal 的值
function _updateCurrentUrlSignal() {
    _currentUrlSignal(_getCurrentLocationString());
}

// 监听 'popstate' 事件，当用户通过浏览器前进/后退按钮导航时触发
window.addEventListener("popstate", () => {
    _updateCurrentUrlSignal();
});

// 全局点击事件监听器，用于拦截 <a> 标签的点击并实现客户端导航
document.addEventListener("click", (event) => {
    // 寻找被点击元素或其祖先元素中的 <a> 标签
    const anchor = event.target.closest("a");

    if (anchor && anchor.href) {
        // 解析 <a> 标签的 href 为一个完整的 URL 对象，以便于比较 origin
        const targetUrl = new URL(anchor.href, window.location.origin);

        // 检查是否是同源导航
        // 1. targetUrl.origin 必须与当前页面 origin 相同
        // 2. <a> 标签没有 target="_blank" 等意图在新窗口打开的属性
        // 3. 用户没有按住修饰键 (Ctrl, Meta, Shift, Alt) 意图在新标签页或新窗口打开
        // 4. <a> 标签没有 download 属性
        if (
            targetUrl.origin === window.location.origin &&
            !anchor.target && // 常见的 target 值如 _blank, _self, _parent, _top
            !event.metaKey && // Command 键 (macOS) 或 Windows 键
            !event.ctrlKey && // Control 键
            !event.shiftKey &&
            !event.altKey &&
            anchor.getAttribute("download") === null // 没有 download 属性
        ) {
            const newLocationString = targetUrl.pathname + targetUrl.search + targetUrl.hash;
            // 仅当目标 URL 与当前 URL 不同时才进行导航
            if (_getCurrentLocationString() !== newLocationString) {
                event.preventDefault(); // 阻止浏览器的默认页面跳转行为
                history.pushState(null, "", anchor.href); // 更新浏览器地址栏，并添加历史记录
                _updateCurrentUrlSignal(); // 手动更新我们的 URL Signal
            } else {
                // 如果 URL 相同，但可能只是 hash 不同，某些情况下也需要阻止默认行为（例如，页面内平滑滚动）
                // 但对于纯粹的路由，如果 pathname+search+hash 都相同，通常不需要 pushState
                // 如果目标是当前页面的 hash，浏览器默认行为是滚动到锚点，这里也阻止它，让路由逻辑统一处理
                if (anchor.href.includes("#") && targetUrl.pathname === window.location.pathname && targetUrl.search === window.location.search) {
                    event.preventDefault();
                    // 如果只是 hash 变化，也需要 pushState 来确保 popstate 能正确工作
                    // 并且 _updateCurrentUrlSignal 确保了即使只是 hash 变化，监听器也能收到通知
                    if (_getCurrentLocationString() !== newLocationString) {
                        // 再次检查，因为上面可能没进去
                        history.pushState(null, "", anchor.href);
                        _updateCurrentUrlSignal();
                    }
                }
            }
        }
    }
});

/**
 * 创建一个 URL 监听器。
 * 当浏览器当前的 URL 路径与提供的模式匹配或不再匹配时，调用相应的回调函数。
 * @param {string|RegExp} urlPattern - 用于匹配 URL 的正则表达式或字符串。
 *                                   如果是字符串，它将被直接用作 RegExp 的构造参数。
 *                                   建议直接使用 RegExp 对象以获得更精确的控制。
 *                                   该模式将与 `window.location.pathname + window.location.search + window.location.hash` 进行匹配。
 * @param {Function} onMatch - 当 URL 从不匹配变为匹配 `urlPattern` 时调用的回调函数。
 *                             回调函数会接收一个参数：匹配到的 URL 字符串。
 * @param {Function} onUnmatch - 当 URL 从匹配 `urlPattern` 变为不匹配时调用的回调函数。
 *                               回调函数会接收一个参数：新的、不匹配的 URL 字符串。
 * @returns {Function} 一个停止函数。调用此函数将停止对 URL 变化的监听，并注销相关的 effect。
 */
function createUrlWatch(urlPattern, onMatch, onUnmatch) {
    let regex;
    if (urlPattern instanceof RegExp) {
        regex = urlPattern;
    } else if (typeof urlPattern === "string") {
        try {
            // 注意：如果字符串 urlPattern 包含特殊的正则表达式元字符，
            // 用户需要确保它们被正确转义，或者框架需要提供更复杂的模式解析。
            // 此处简单地将字符串视为正则表达式模式。
            regex = new RegExp(urlPattern);
        } catch (e) {
            console.error(`[NueCore.createUrlWatch] 无效的正则表达式字符串: "${urlPattern}"`, e);
            return () => {}; // 返回一个无操作的停止函数
        }
    } else {
        console.error("[NueCore.createUrlWatch] urlPattern 参数必须是字符串或 RegExp 对象。");
        return () => {};
    }

    let wasMatched = false; // 用于追踪上一次的匹配状态

    // 使用 NueCore.createWatch 来监听 _currentUrlSignal 的变化
    // immediate: true 确保在创建此 watch 时，会立即根据当前 URL 执行一次回调逻辑
    const stopWatchingSignal = createWatch(
        _currentUrlSignal,
        (newUrlString) => {
            const isNowMatched = regex.test(newUrlString);

            if (isNowMatched && !wasMatched) {
                // 从不匹配 -> 匹配
                if (typeof onMatch === "function") {
                    try {
                        onMatch(newUrlString);
                    } catch (e) {
                        console.error("[NueCore.createUrlWatch] onMatch 回调执行出错:", e);
                    }
                }
            } else if (!isNowMatched && wasMatched) {
                // 从匹配 -> 不匹配
                if (typeof onUnmatch === "function") {
                    try {
                        onUnmatch(newUrlString);
                    } catch (e) {
                        console.error("[NueCore.createUrlWatch] onUnmatch 回调执行出错:", e);
                    }
                }
            }
            wasMatched = isNowMatched; // 更新匹配状态
        },
        { immediate: true },
    );

    // 返回的停止函数，调用它会停止内部的 createWatch
    return stopWatchingSignal;
}

/**
 * 编程式导航函数。
 * @param {string} path - 要导航到的路径 (例如, '/users/1', '/about?q=nue', '#section').
 * @param {object} [state=null] - (可选) 传递给 history.pushState 的状态对象。
 * @param {string} [title=''] - (可选) 传递给 history.pushState 的标题 (通常被浏览器忽略)。
 */
function navigateTo(path, state = null, title = "") {
    const newLocationString = new URL(path, window.location.origin).pathname + new URL(path, window.location.origin).search + new URL(path, window.location.origin).hash;

    if (_getCurrentLocationString() !== newLocationString) {
        history.pushState(state, title, path);
        _updateCurrentUrlSignal();
    }
}

// === 路由功能结束 ===

// 组件及模块相关缓存与注册表
const componentCache = new Map(); // 缓存组件文本、结构、AST: { versionedUrl -> { text, structure, ast, originalUrl } }
const _pendingRequests = new Map(); // 缓存正在进行的组件/NJS文件文本 fetch 请求: { versionedUrl -> Promise<text> }
const componentCleanupRegistry = new WeakMap(); // 存储组件卸载时的清理回调: { mountedRootElement -> onUnmountFunction }

// NJS 模块相关缓存
const njsModuleExecutionCache = new Map(); // NJS模块执行结果缓存: { versionedUrl -> moduleData }
const _pendingNjsModuleLoads = new Map(); // 进行中的NJS模块加载请求: { versionedUrl -> Promise<moduleData> }

// 辅助函数

/**
 * 解析 URL，将相对路径转换为基于指定基准 URL 的绝对路径。
 * @param {string} relativeOrAbsoluteUrl - 需要解析的 URL，可以是相对路径或绝对路径。
 * @param {string} [baseComponentUrl] - 用于解析相对路径的基准 URL。如果未提供，则使用当前窗口的 location.href。
 * @returns {string} 解析后的绝对 URL。如果解析失败，则返回原始 URL。
 */
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

/**
 * 根据原始 URL 和应用版本号生成版本化 URL 和原始绝对 URL。
 * @param {string} rawUrl - 原始的 URL 字符串（可以是相对或绝对路径）。
 * @param {string} [baseComponentUrlForResolution] - 用于解析 rawUrl（如果是相对路径）的基准 URL。
 * @returns {{versionedUrl: string, originalUrl: string}} 包含版本化 URL 和原始绝对 URL 的对象。
 */
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

/**
 * 解析 .nue 文件（或其他类似 SFC 结构的文件）的文本内容，提取 template, script, style 部分。
 * @param {string} text - 组件文件的完整文本内容。
 * @param {string} versionedUrl - 组件的版本化 URL，用于缓存键和日志。
 * @returns {{template: string, script: string, style: string}} 包含 template, script, style 字符串的对象。
 */
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

/**
 * 使用 Acorn 解析器将 JavaScript 脚本内容解析为抽象语法树 (AST)。
 * @param {string} scriptContent - 要解析的 JavaScript 脚本字符串。
 * @param {string} versionedUrl - 脚本来源的版本化 URL，用于缓存键和日志。
 * @returns {object|null} Acorn 生成的 AST 对象，如果解析失败或 Acorn 未加载则返回 null。
 */
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

/**
 * 内部函数，用于执行 NJS 脚本内容。支持顶层 await。
 * @param {string} scriptContent - NJS 文件的 JavaScript 文本内容。
 * @param {string} njsVersionedUrl - NJS 文件的版本化 URL (主要用于缓存键)。
 * @param {string} njsOriginalUrl - NJS 文件的原始绝对 URL。
 * @returns {Promise<*>} 一个 Promise，解析为 NJS 脚本执行后返回的结果。
 * @throws {Error} 如果脚本执行失败，会重新抛出原始错误。
 */
async function _executeNjsScript(scriptContent, njsVersionedUrl, njsOriginalUrl) {
    if (!scriptContent.trim()) {
        // 对于空脚本，可以只警告一次，不设置 primaryError 标志，因为它不一定是致命的
        // (或者根据你的需求决定是否也将其视为主要错误来源)
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
        // 捕获来自 new Function 或 await resultPromise 的错误
        throw error; // 重新抛出原始错误
    }
}

/**
 * 核心的 NJS 模块加载和执行函数。这是实现 `importNjs` 功能的主体。
 * @param {string} relativePath - 需要加载的 NJS 文件的路径 (可以是相对路径或绝对路径)。
 * @param {string} baseOriginalUrl - 调用 importNjs 的那个文件的原始绝对 URL (组件文件或父 NJS 文件)。用于解析 relativePath。
 * @returns {Promise<*>} 一个 Promise，解析为加载并执行后的 NJS 模块数据。
 */
async function _loadAndExecuteNjsModule(relativePath, baseOriginalUrl) {
    const { versionedUrl, originalUrl } = getVersionedAndOriginalUrls(relativePath, baseOriginalUrl);

    // 步骤 1: 检查内存中已执行的结果缓存
    if (njsModuleExecutionCache.has(versionedUrl)) {
        return njsModuleExecutionCache.get(versionedUrl);
    }

    // 步骤 2: 检查进行中的加载请求缓存
    if (_pendingNjsModuleLoads.has(versionedUrl)) {
        return _pendingNjsModuleLoads.get(versionedUrl);
    }

    // 步骤 3: 启动新的加载和执行过程
    const loadPromise = (async () => {
        try {
            // 3.1 加载 NJS 文件的文本内容 (复用组件加载逻辑)
            const scriptText = await fetchAndCacheComponentText(versionedUrl, originalUrl);

            // 3.2 执行 NJS 脚本 (返回 Promise)
            const executionResultPromise = _executeNjsScript(scriptText, versionedUrl, originalUrl);
            const finalModuleData = await executionResultPromise; // 等待脚本内部的 async 操作完成

            // 3.3 将模块数据存入结果缓存
            njsModuleExecutionCache.set(versionedUrl, finalModuleData);
            return finalModuleData;
        } catch (error) {
            // 错误已在 _executeNjsScript 或 fetchAndCacheComponentText 中打印
            console.error(`核心错误：NJS 模块 ${originalUrl} 的加载或执行流程失败。`);
            throw error; // 重新抛出，以便上层处理
        }
    })();

    _pendingNjsModuleLoads.set(versionedUrl, loadPromise); // 存入进行中请求的缓存

    loadPromise.finally(() => {
        _pendingNjsModuleLoads.delete(versionedUrl); // 无论成功或失败，都从进行中缓存移除
    });

    return loadPromise;
}

/**
 * 执行组件的 <script> 块内容。支持顶层 await。
 * @param {string} scriptContent - 组件 <script> 块的文本内容。
 * @param {object|null} ast - 由 Acorn 解析得到的脚本 AST (可选)。
 * @param {object} [initialProps={}] - 传递给组件的初始 props 对象。
 * @param {Function} [emit=() => {}] - 子组件用于向父组件派发事件的函数。
 * @param {string} componentOriginalUrl - 组件的原始绝对 URL。
 * @returns {Promise<object>} 一个 Promise，解析为组件的作用域对象。
 * @throws {Error} 如果脚本执行失败，会重新抛出原始错误。
 */
async function executeScript(scriptContent, ast, initialProps = {}, emit = () => {}, componentOriginalUrl) {
    if (!scriptContent.trim()) {
        return {};
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
            return componentScope;
        } else {
            throw err; // 抛出错误以中断流程
        }
    } catch (error) {
        // 捕获来自 new Function 或 await componentScopePromise 的错误
        throw error; // 重新抛出原始错误，让上层处理
    }
}

/**
 * 创建一个 emit 函数，供子组件用于向父组件发送事件。
 * @param {object} eventHandlers - 父组件提供的事件处理器集合，键为事件名，值为处理函数。
 * @param {string} [componentName="子组件"] - 组件的名称，用于日志。
 * @returns {Function} emit 函数，接收 (eventName, payload) 参数。
 */
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

/**
 * 将短横线命名 (kebab-case) 字符串转换为驼峰命名 (camelCase) 字符串。
 * @param {string} kebabCase - 短横线命名的字符串。
 * @returns {string} 驼峰命名的字符串。
 */
function kebabToCamel(kebabCase) {
    return kebabCase.replace(/-([a-z])/g, (match, letter) => letter.toUpperCase());
}

/**
 * 获取并缓存组件或 NJS 文件的文本内容。
 * 会依次尝试从预加载数据、localStorage、内存缓存获取，如果均未命中，则发起网络请求。
 * @param {string} versionedUrl - 资源的版本化 URL。
 * @param {string} originalAbsoluteUrl - 资源的原始绝对 URL。
 * @returns {Promise<string>} 一个 Promise，解析为资源的文本内容。
 */
async function fetchAndCacheComponentText(versionedUrl, originalAbsoluteUrl) {
    // 步骤 1: 检查全局预加载数据 (window.__NUE_PRELOADED_DATA__)
    if (window.__NUE_PRELOADED_DATA__ && typeof window.__NUE_PRELOADED_DATA__ === "object" && window.__NUE_PRELOADED_DATA__.hasOwnProperty(originalAbsoluteUrl)) {
        const confusedTextFromBundle = window.__NUE_PRELOADED_DATA__[originalAbsoluteUrl];

        // 对从预加载包中获取的文本进行解混淆
        const preloadedText = nueSimpleTransform(confusedTextFromBundle, __NUE_CONFUSION_KEY__);

        // 将解混淆后的文本也放入内存缓存 componentCache，以便后续逻辑可以从中获取
        // 并且避免对同一资源重复检查 __NUE_PRELOADED_DATA__
        // componentCache 仍然以 versionedUrl 为键
        if (!componentCache.has(versionedUrl)) {
            componentCache.set(versionedUrl, { text: preloadedText, structure: null, ast: null, originalUrl: originalAbsoluteUrl });
        } else {
            // 如果已存在（理论上不应该在首次获取时发生，除非有并发或特殊情况），确保文本是最新的
            const cachedEntry = componentCache.get(versionedUrl);
            cachedEntry.text = preloadedText;
            cachedEntry.originalUrl = originalAbsoluteUrl; // 确保 originalUrl 也正确
        }
        // console.log(`[NueCore] 已使用预加载数据 (并解混淆) 加载: ${originalAbsoluteUrl}`);
        return Promise.resolve(preloadedText); // 直接返回解混淆后的文本
    }

    // 步骤 2: 尝试从内存缓存获取 (原有逻辑)
    const memoryCached = componentCache.get(versionedUrl);
    if (memoryCached && typeof memoryCached.text === "string") {
        // 确保 text 存在且是字符串
        // console.log(`[NueCore] 已从内存缓存加载: ${originalAbsoluteUrl}`);
        return memoryCached.text; // 内存缓存中的文本也应该是原始的
    }

    // 步骤 3: 如果有正在进行的 fetch 请求，则返回该请求的 Promise (原有逻辑)
    if (_pendingRequests.has(versionedUrl)) {
        // console.log(`[NueCore] 等待正在进行的请求: ${originalAbsoluteUrl}`);
        return _pendingRequests.get(versionedUrl);
    }

    // 步骤 4: 发起新的 fetch 请求 (原有逻辑)
    // console.log(`[NueCore] 发起网络请求: ${originalAbsoluteUrl}`);
    const fetchPromise = fetch(versionedUrl)
        .then((response) => {
            if (!response.ok) {
                throw new Error(`加载资源 ${versionedUrl} (原始: ${originalAbsoluteUrl}) 失败: ${response.status} ${response.statusText}`);
            }
            return response.text();
        })
        .then((text) => {
            // 网络获取的是原始文本
            componentCache.set(versionedUrl, { text, structure: null, ast: null, originalUrl: originalAbsoluteUrl });
            _pendingRequests.delete(versionedUrl); // 从挂起请求中移除
            // console.log(`[NueCore] 网络请求成功并缓存: ${originalAbsoluteUrl}`);
            return text;
        })
        .catch((error) => {
            _pendingRequests.delete(versionedUrl); // 请求失败也从挂起中移除
            console.error(`核心错误：获取资源 ${versionedUrl} (原始: ${originalAbsoluteUrl}) 文本失败:`, error);
            throw error; // 重新抛出错误
        });

    _pendingRequests.set(versionedUrl, fetchPromise); // 将新的 fetch Promise 存入挂起请求
    return fetchPromise;
}

/**
 * 编译 DOM 节点，处理指令、插值、子组件和插槽。
 * @param {Node} node - 需要编译的 DOM 节点。
 * @param {object} scope - 当前节点编译时所处的作用域对象。
 * @param {object} directiveHandlers - 包含指令处理逻辑的对象 (如 NueDirectives)。
 * @param {string} [parentComponentName="根组件"] - 父组件的名称，用于日志。
 * @param {string|null} [currentContextOriginalUrl=null] - 当前编译上下文的原始 URL (父组件或NJS的URL)，用于解析子组件相对路径。
 */
function compileNode(node, scope, directiveHandlers, parentComponentName = "根组件", currentContextOriginalUrl = null) {
    if (!directiveHandlers || typeof directiveHandlers.evaluateExpression !== "function") {
        console.error(`核心错误：[${parentComponentName}] 指令处理器或 evaluateExpression 未准备好，编译中止。`);
        return;
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node;
        const tagName = element.tagName.toLowerCase();

        // --- 处理子组件 (自定义标签，包含 '-') ---
        if (tagName.includes("-") && !["template", "script", "style", "slot"].includes(tagName)) {
            const srcAttr = element.getAttribute("src");
            const rawComponentPath = srcAttr ? srcAttr : `${tagName}.nue`;
            // currentContextOriginalUrl 是父组件的 URL，用于解析子组件的相对路径
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
                    // 动态 prop
                    const rawPropName = attrName.substring(1);
                    const camelCasePropName = kebabToCamel(rawPropName);
                    const expression = attrValue;
                    const propSignal = createSignal(undefined);
                    // 动态 prop 的求值作用域是父组件的 scope
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
                    // 事件绑定
                    const eventName = attrName.substring(1);
                    const handlerExpression = attrValue;
                    // 事件处理器的执行作用域是父组件的 scope
                    eventHandlers[eventName] = (payload) => {
                        try {
                            const context = Object.create(scope); // 父组件 scope
                            context.$event = payload;
                            const result = directiveHandlers.evaluateExpression(handlerExpression, context);
                            if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(handlerExpression.trim()) && typeof result === "function") {
                                result.call(scope, payload); // this 指向父组件 scope
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
            // slotsDataForChild 将存储每个插槽的原始DOM节点列表、定义它们时的父作用域以及父上下文URL
            const slotsDataForChild = {};
            const slotContentContainer = document.createDocumentFragment();
            // 将子组件标签内的所有子节点移动到临时容器中，以提取插槽内容
            Array.from(element.childNodes).forEach((cn) => slotContentContainer.appendChild(cn));

            const rawSlotContents = { default: [] }; // 用于临时收集各插槽的原始DOM节点
            Array.from(slotContentContainer.childNodes).forEach((childNode) => {
                if (childNode.nodeType === Node.ELEMENT_NODE && childNode.tagName.toLowerCase() === "template") {
                    if (childNode.hasAttribute("slot")) {
                        let slotNameAttr = (childNode.getAttribute("slot") || "").trim() || "default";
                        if (!rawSlotContents[slotNameAttr]) rawSlotContents[slotNameAttr] = [];
                        const templateContent = childNode.content; // <template> 标签的内容在 template.content DocumentFragment 中
                        // 克隆 <template> 的内容节点，以保留原始结构
                        if (templateContent) Array.from(templateContent.childNodes).forEach((c) => rawSlotContents[slotNameAttr].push(c.cloneNode(true)));
                    } else {
                        // 没有 slot 属性的 <template> 也视为默认插槽的一部分
                        const templateContent = childNode.content;
                        if (templateContent) Array.from(templateContent.childNodes).forEach((c) => rawSlotContents.default.push(c.cloneNode(true)));
                    }
                } else if (!(childNode.nodeType === Node.TEXT_NODE && childNode.nodeValue.trim() === "")) {
                    // 非空文本节点或非 <template> 元素节点，视为默认插槽内容
                    rawSlotContents.default.push(childNode.cloneNode(true)); // 克隆节点
                }
            });

            // 为每个插槽准备数据：原始节点列表、父作用域和父上下文URL
            // 这些数据将传递给子组件，在子组件渲染 <slot> 标签时使用
            for (const sName in rawSlotContents) {
                if (rawSlotContents[sName].length > 0) {
                    slotsDataForChild[sName] = {
                        nodes: rawSlotContents[sName], // 原始DOM节点数组 (已克隆)
                        parentScope: scope, // 定义这些插槽内容时的父组件作用域
                        parentContextOriginalUrl: currentContextOriginalUrl, // 父组件的原始URL，用于解析插槽内容中可能存在的相对路径子组件
                    };
                }
            }

            attributesToRemove.forEach((attrName) => element.removeAttribute(attrName));
            const placeholder = document.createComment(`component-placeholder: ${tagName}`);
            if (!element.parentNode) {
                console.error(`核心错误：[${parentComponentName}] 子组件 <${tagName}> 在替换为占位符前已无父节点。`);
                return;
            }
            element.parentNode.replaceChild(placeholder, element);

            // 异步挂载子组件，传递 props、事件处理器、组件名建议、插槽数据和子组件的原始URL
            mountComponent(childVersionedUrl, placeholder, initialProps, eventHandlers, tagName, slotsDataForChild, childOriginalUrl).catch((error) => console.error(`核心错误：[${parentComponentName}] 异步挂载子组件 <${tagName}> (${childVersionedUrl}) 失败:`, error));
            return; // 子组件已处理，不再继续编译此节点
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
            const slotName = element.getAttribute("name") || "default";
            // scope 是当前组件 (子组件) 的作用域
            // scope.$slots 存储了从父组件传递过来的插槽数据: { name: { nodes: Node[], parentScope: Scope, parentContextOriginalUrl: string } }
            const slotDataFromParent = scope.$slots && scope.$slots[slotName];
            const parentOfSlotTag = element.parentNode; // <slot> 标签的父节点

            if (parentOfSlotTag) {
                if (slotDataFromParent && slotDataFromParent.nodes && slotDataFromParent.nodes.length > 0) {
                    // 如果父组件为此插槽提供了内容
                    const { nodes: rawNodesToCompile, parentScope: slotContentParentScope, parentContextOriginalUrl: slotContentParentContextUrl } = slotDataFromParent;

                    const contentFragmentForSlot = document.createDocumentFragment();
                    // 克隆父组件提供的原始DOM节点到新的 DocumentFragment 中
                    rawNodesToCompile.forEach((rawNode) => contentFragmentForSlot.appendChild(rawNode.cloneNode(true)));

                    // 使用父组件的作用域 (slotContentParentScope) 和父组件的上下文URL (slotContentParentContextUrl)
                    // 来编译这些克隆后的插槽内容节点。
                    // 这样，插槽内容中的表达式和事件绑定都将在其定义的父组件作用域中执行。
                    Array.from(contentFragmentForSlot.childNodes).forEach((nodeToCompileInSlot) => {
                        compileNode(nodeToCompileInSlot, slotContentParentScope, directiveHandlers, `${parentComponentName} (slot '${slotName}' content from parent)`, slotContentParentContextUrl);
                    });
                    // 将编译好的插槽内容插入到 <slot> 标签之前
                    parentOfSlotTag.insertBefore(contentFragmentForSlot, element);
                } else {
                    // 如果父组件未提供内容，则渲染 <slot> 标签的后备内容
                    const fallbackFragment = document.createDocumentFragment();
                    while (element.firstChild) {
                        // 移动 <slot> 标签的所有子节点 (即后备内容) 到 fallbackFragment
                        fallbackFragment.appendChild(element.firstChild);
                    }
                    // 后备内容的编译作用域是当前子组件的 scope，上下文URL也是子组件的
                    Array.from(fallbackFragment.childNodes).forEach((fallbackNode) => {
                        compileNode(fallbackNode, scope, directiveHandlers, `${parentComponentName} (slot '${slotName}' fallback)`, currentContextOriginalUrl);
                    });
                    // 将编译好的后备内容插入到 <slot> 标签之前
                    parentOfSlotTag.insertBefore(fallbackFragment, element);
                }
                // 移除 <slot> 标签本身
                parentOfSlotTag.removeChild(element);
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
                        const context = Object.create(scope); // 当前作用域
                        context.$event = event;
                        const result = directiveHandlers.evaluateExpression(attrValue, context);
                        // 如果表达式解析为一个函数名，并且结果确实是函数，则以当前 scope 为 this 调用
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

        // 递归编译当前元素的子节点
        // 子节点的编译上下文URL与当前节点相同
        Array.from(element.childNodes).forEach((child) => compileNode(child, scope, directiveHandlers, `${parentComponentName} > ${element.tagName.toUpperCase()}`, currentContextOriginalUrl));
    } else if (node.nodeType === Node.TEXT_NODE) {
        // 处理文本节点中的插值 {{ ... }}
        const textContent = node.textContent || "";
        const mustacheRegex = /\{\{([^}]+)\}\}/g;
        if (!mustacheRegex.test(textContent)) return; // 无插值则不处理

        const segments = [];
        let lastIndex = 0;
        let match;
        mustacheRegex.lastIndex = 0; // 重置正则 lastIndex
        while ((match = mustacheRegex.exec(textContent)) !== null) {
            if (match.index > lastIndex) {
                // 表达式前的普通文本
                segments.push(document.createTextNode(textContent.substring(lastIndex, match.index)));
            }
            const expression = match[1].trim();
            const placeholderNode = document.createTextNode(""); // 为表达式结果创建占位文本节点
            segments.push(placeholderNode);

            // 监听表达式依赖变化并更新占位符，作用域是当前 scope
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

/**
 * 将组件的 CSS 样式注入到文档的 <head> 中。
 * @param {string} css - 要注入的 CSS 字符串。
 * @param {string} originalComponentUrl - 组件的原始 URL，用于生成唯一的 style 标签 ID，防止重复注入。
 */
function injectStyles(css, originalComponentUrl) {
    if (!css || !css.trim()) return;
    const styleId = `nono-style-${originalComponentUrl.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    if (document.getElementById(styleId)) return; // 已存在则不重复注入

    const styleElement = document.createElement("style");
    styleElement.id = styleId;
    styleElement.textContent = css;
    document.head.appendChild(styleElement);
}

/**
 * 清理指定 DOM 节点及其所有子孙节点，并执行相关的卸载回调和 Effect 清理。
 * @param {Node} node - 需要清理和移除的 DOM 节点。
 */
function cleanupAndRemoveNode(node) {
    if (!node) return;

    if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.hasChildNodes()) {
            // 递归清理子节点
            Array.from(node.childNodes).forEach((child) => cleanupAndRemoveNode(child));
        }

        // 执行与此组件根元素关联的自动注册的 Effect 清理函数
        if (componentEffectsRegistry.has(node)) {
            const effectsToStop = componentEffectsRegistry.get(node);
            effectsToStop.forEach((stopFn) => {
                try {
                    stopFn(); // 执行每个 Effect 的清理函数
                } catch (error) {
                    console.error(`核心错误：自动清理 Effect 时出错 (元素: ${node.tagName || "Node"}):`, error);
                }
            });
            componentEffectsRegistry.delete(node); // 清理完成后，从注册表中移除
        }

        // 执行用户定义的卸载回调 (onUnmount)
        const cleanupCallback = componentCleanupRegistry.get(node);
        if (typeof cleanupCallback === "function") {
            try {
                cleanupCallback();
            } catch (error) {
                console.error(`核心错误：执行 onUnmount 钩子时出错 (元素: ${node.tagName || "Node"}):`, error);
            }
            componentCleanupRegistry.delete(node); // 移除回调
        }
    }
    // 从 DOM 中移除节点
    if (node.parentNode) {
        node.parentNode.removeChild(node);
    }
}

/**
 * 挂载组件的核心函数。
 * 负责加载组件文件、解析内容、执行脚本、编译模板并渲染到指定 DOM 目标。
 *
 * @param {string} componentFile - 要挂载的组件的文件路径 (相对或绝对)。
 * @param {string|Element|Comment} targetSelectorOrElement - 组件挂载目标 (CSS选择器、DOM元素或注释节点)。
 * @param {object} [initialProps={}] - 传递给组件的初始 props。
 * @param {object} [eventHandlers={}] - (子组件用) 父组件提供的事件处理器。
 * @param {string} [componentNameSuggestion] - (子组件用) 组件名建议，用于日志。
 * @param {object} [slotsDataFromParent={}] - (子组件用) 父组件传递的插槽数据，结构为 { slotName: { nodes: Node[], parentScope: Scope, parentContextOriginalUrl: string } }。
 * @param {string} [baseResolutionUrlOverride] - (子组件用) 解析 `componentFile` 相对路径的基准 URL。
 * @returns {Promise<Element|null>} Promise 解析为挂载的组件根 DOM 元素，失败则为 null。
 */
async function mountComponent(componentFile, targetSelectorOrElement, initialProps = {}, eventHandlers = {}, componentNameSuggestion, slotsDataFromParent = {}, baseResolutionUrlOverride) {
    // --- 步骤 A: 解析 URL 和确定组件名 ---
    // baseResolutionUrlOverride 用于当 mountComponent 被递归调用挂载子组件时，确保子组件的相对路径是基于其父组件的原始URL进行解析的。
    // 对于根组件挂载，此参数通常为 null 或 undefined，此时 getVersionedAndOriginalUrls 会使用 window.location.href 作为基准。
    const { versionedUrl: versionedComponentUrl, originalUrl: originalAbsoluteUrl } = getVersionedAndOriginalUrls(componentFile, baseResolutionUrlOverride || null);

    let componentName = componentNameSuggestion;
    if (!componentName) {
        const fileName = originalAbsoluteUrl.substring(originalAbsoluteUrl.lastIndexOf("/") + 1);
        const nameParts = fileName.split(".");
        componentName = nameParts[0] || "组件";
    }

    // --- 步骤 B: 组件挂载核心逻辑 ---
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

    // 检查依赖是否加载
    if (typeof window.acorn === "undefined") {
        console.error(`核心错误：[${componentName}] Acorn 解析器 (acorn.js) 未加载！`);
        if (targetElement instanceof Element && !isPlaceholder) {
            targetElement.innerHTML = `<p style="color: red;">错误：[${componentName}] Acorn 解析器 (acorn.js) 未加载</p>`;
        }
        return null;
    }
    if (typeof window.NueDirectives === "undefined" || typeof window.NueDirectives.evaluateExpression !== "function") {
        console.error(`核心错误：[${componentName}] 指令处理器 (nono-directives.js) 或其 evaluateExpression 方法未加载！`);
        if (targetElement instanceof Element && !isPlaceholder) {
            targetElement.innerHTML = `<p style="color: red;">错误：[${componentName}] 指令处理器 (nono-directives.js) 未加载</p>`;
        }
        return null;
    }

    // 为当前组件实例准备 Effect 清理列表
    const effectsForThisComponent = [];
    const previousEffectCleanupList = _currentEffectCleanupList;
    _currentEffectCleanupList = effectsForThisComponent; // 后续 createEffect 将注册到此列表

    let mountedRootElement = null; // 实际挂载到 DOM 树上的组件根元素

    try {
        // B.3: 获取组件的文本内容
        const componentText = await fetchAndCacheComponentText(versionedComponentUrl, originalAbsoluteUrl);
        let cacheEntry = componentCache.get(versionedComponentUrl);
        if (!cacheEntry) {
            console.error(`核心严重错误：组件 ${componentName} (${versionedComponentUrl}) 文本已获取，但内存缓存条目丢失！将尝试重新创建。`);
            cacheEntry = { text: componentText, structure: null, ast: null, originalUrl: originalAbsoluteUrl };
            componentCache.set(versionedComponentUrl, cacheEntry);
        }

        // B.4: 解析组件结构
        if (!cacheEntry.structure) {
            cacheEntry.structure = parseComponentStructure(componentText, versionedComponentUrl);
        }
        const { template, script, style } = cacheEntry.structure;

        // B.5: 使用 Acorn 解析 <script> 内容为 AST
        if (script.trim() && !cacheEntry.ast) {
            cacheEntry.ast = parseScriptWithAcorn(script, versionedComponentUrl);
        }
        const ast = cacheEntry.ast;

        // B.6: 执行组件的 <script> 块
        const emit = createEmitFunction(eventHandlers, componentName);
        // originalAbsoluteUrl 是当前组件的原始URL，用于其内部 importNjs 的路径解析
        const componentScope = await executeScript(script, ast, initialProps, emit, originalAbsoluteUrl);

        // B.7: 将父组件传入的插槽数据 (原始节点和父作用域) 注入子组件作用域的 $slots 属性
        if (componentScope && typeof componentScope === "object") {
            componentScope.$slots = slotsDataFromParent; // slotsDataFromParent 包含 { name: { nodes, parentScope, parentContextOriginalUrl } }
        } else {
            if (componentScope !== null && typeof componentScope !== "undefined") {
                console.warn(`核心警告：组件 ${componentName} 的脚本已执行，但未返回有效的对象作用域 (实际返回: ${typeof componentScope})，无法注入 $slots。`);
            } else {
                console.warn(`核心警告：组件 ${componentName} 的脚本执行后返回 ${componentScope}，无法注入 $slots。`);
            }
        }

        // B.8: 根据模板创建 DOM 片段
        const fragment = document.createDocumentFragment();
        const tempDiv = document.createElement("div");
        tempDiv.innerHTML = template.trim(); // 将模板字符串解析为DOM
        while (tempDiv.firstChild) {
            fragment.appendChild(tempDiv.firstChild); // 将解析后的节点移到 fragment 中
        }
        const potentialRootElementInFragment = fragment.firstElementChild; // 可能是组件的根元素

        // B.9: 编译 DOM 片段。
        // 编译时使用的上下文URL是当前组件的 originalAbsoluteUrl。
        Array.from(fragment.childNodes).forEach((node) => compileNode(node, componentScope, window.NueDirectives, componentName, originalAbsoluteUrl));

        // B.10: 注入样式
        injectStyles(style, originalAbsoluteUrl);

        // B.11: 挂载 DOM 片段
        if (isPlaceholder) {
            // 替换注释占位符
            const parent = targetElement.parentNode;
            if (parent) {
                parent.insertBefore(fragment, targetElement);
                mountedRootElement = potentialRootElementInFragment; // 假设片段的第一个元素是组件根
                parent.removeChild(targetElement); // 移除占位符
            } else {
                console.warn(`核心警告：[${componentName}] 尝试挂载到已脱离 DOM 的占位符，操作可能未生效。`);
            }
        } else {
            // 替换目标元素内容
            cleanupAndRemoveNode(targetElement.firstChild); // 清理目标元素内所有现有子节点
            targetElement.innerHTML = ""; // 确保清空
            mountedRootElement = fragment.firstElementChild; // 假设片段的第一个元素是组件根
            targetElement.appendChild(fragment);
        }

        // 关联收集到的 Effect 清理函数与组件根元素
        if (mountedRootElement && effectsForThisComponent.length > 0) {
            componentEffectsRegistry.set(mountedRootElement, new Set(effectsForThisComponent));
        }

        // B.12: 执行 onMount 生命周期钩子
        if (mountedRootElement && componentScope && typeof componentScope.onMount === "function") {
            try {
                await componentScope.onMount(); // 支持异步 onMount
            } catch (error) {
                console.error(`核心错误：[${componentName}] 执行 onMount 钩子时出错:`, error);
            }
            // 如果 onMount 存在，则检查并注册 onUnmount
            if (typeof componentScope.onUnmount === "function") {
                componentCleanupRegistry.set(mountedRootElement, componentScope.onUnmount);
            }
        }
        return mountedRootElement;
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
        // 恢复外部的 Effect 清理列表上下文
        _currentEffectCleanupList = previousEffectCleanupList;
    }
}

// 暴露核心 API 到 window.NueCore
window.NueCore = {
    /**
     * 初始化并挂载根组件。
     * @param {string} targetId - 根组件挂载目标的 DOM 元素 ID (不含 '#')。
     * @param {string} rootComponentFile - 根组件的文件路径。
     * @param {string} [appVersion] - 应用版本号，用于缓存控制。如果提供，将用于 localStorage 缓存和资源 URL 版本化。
     * @param {object} [initialProps={}] - 传递给根组件的初始 props。
     * @returns {Promise<Element|null>} 一个 Promise，解析为挂载的根组件的 DOM 元素；如果挂载失败，则解析为 null。
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
        } else {
            NueCoreConfig.appVersion = null;
            if (appVersion !== undefined) {
                console.warn(`核心警告：提供的应用版本号无效，组件将不带版本参数加载，localStorage 缓存将不基于版本。`);
            }
        }

        const targetSelector = `#${targetId}`;
        return mountComponent(rootComponentFile, targetSelector, initialProps);
    },
    /**
     * 导出当前已加载到 componentCache 中的所有组件和 NJS 模块的（混淆后）文本内容。
     * 生成一个包含这些数据的 JS 文件，并触发浏览器下载。
     * @param {string} [filename='nue-data-bundle.js'] - 下载的 JS 文件的名称。
     */
    exportDependencyBundle: function (filename = "nue-data-bundle.js") {
        const dataToExport = {};
        let exportedCount = 0;

        // 遍历 componentCache，获取每个条目的 originalUrl 和原始文本
        // componentCache 是在 nono-core.js 顶层作用域定义的，此处可以直接访问
        for (const [versionedUrl, cacheEntry] of componentCache.entries()) {
            // 确保条目有效且包含原始 URL 和文本
            if (cacheEntry && cacheEntry.originalUrl && typeof cacheEntry.text === "string") {
                // 对原始文本进行混淆
                const confusedText = nueSimpleTransform(cacheEntry.text, __NUE_CONFUSION_KEY__);
                dataToExport[cacheEntry.originalUrl] = confusedText; // 存储混淆后的文本
                exportedCount++;
            } else {
                console.warn(`[NueCore.exportDependencyBundle] 跳过缓存条目 (版本化URL: ${versionedUrl})，因为它缺少 originalUrl 或文本内容。`);
            }
        }

        if (exportedCount === 0) {
            const message = "[NueCore.exportDependencyBundle] 缓存中没有找到可导出的组件或NJS模块数据。\n请确保您的应用已加载了至少一个 Nue 组件或 NJS 模块。";
            console.warn(message);
            // 可以使用 alert 提示用户，或者如果环境不允许 alert (例如在某些自动化测试中)，则只打印警告
            if (typeof alert === "function") {
                alert(message);
            }
            return; // 没有数据可导出，直接返回
        }

        // 将 dataToExport 对象序列化为一个 JavaScript 字符串，该字符串会定义 window.__NUE_PRELOADED_DATA__
        // 使用 JSON.stringify 的第三个参数 '  ' (两个空格) 来格式化输出的 JSON，使其更易读
        const dataString = `window.__NUE_PRELOADED_DATA__ = ${JSON.stringify(dataToExport, null, "  ")};`;

        // 创建一个 Blob 对象，类型为 'application/javascript'
        const blob = new Blob([dataString], { type: "application/javascript;charset=utf-8" });

        // 创建一个临时的 <a> 标签来触发下载
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob); // 创建一个指向 Blob 的对象 URL
        link.download = filename; // 设置下载文件的名称

        // 将 <a> 标签添加到 DOM 中 (某些浏览器需要这样才能触发点击)
        document.body.appendChild(link);
        link.click(); // 模拟点击以触发下载

        // 清理：从 DOM 中移除 <a> 标签并释放对象 URL
        document.body.removeChild(link);
        URL.revokeObjectURL(link.href);

        console.log(`[NueCore.exportDependencyBundle] ${exportedCount} 个资源的混淆数据已导出为 ${filename}。\n请将此文件包含在您的 HTML 中，并置于 nono-core.js 脚本之前。`);
    },
    createSignal,
    createEffect,
    createWatch, // 也暴露 createWatch
    createUrlWatch,
    navigateTo,
    compileNode, // 暴露编译函数，可能用于高级场景或指令系统扩展
    cleanupAndRemoveNode, // 暴露清理函数
};
