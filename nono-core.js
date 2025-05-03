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
 * 执行组件脚本，返回其作用域（包含 signals 和 methods）
 * @param {string} scriptContent 脚本字符串
 * @param {object} ast Acorn 解析出的 AST (可选，目前主要用于验证)
 * @returns {object} 组件的作用域对象 (由脚本显式 return 返回)
 */
function executeScript(scriptContent, ast) {
    // 可以选择在这里基于 AST 做一些分析或转换，但目前我们只执行原始脚本
    if (ast === null) { // 如果解析失败，不执行
        console.warn("由于脚本解析失败，跳过执行。");
        return {};
    }

    console.log("准备执行脚本 (期望脚本显式返回作用域)...");
    try {
        // 创建一个函数，其主体是用户脚本。
        // 我们现在期望脚本的最后一条语句是 'return { ... }'
        const scriptFunction = new Function('createSignal', `
            // 脚本在此处执行
            ${scriptContent}
            // 脚本作者需要确保最后有 return 语句，例如：
            // return { count, showDetails, items, message, add2ToCount, addItem, removeItem, shuffleItems, changeMessage };
        `);

        // 执行脚本并直接获取其返回值
        const componentScope = scriptFunction(createSignal);

        // 验证返回值是否为对象，这是我们期望的格式
        if (typeof componentScope === 'object' && componentScope !== null) {
            console.log("脚本执行完毕，并成功返回了作用域对象:", componentScope);
            return componentScope;
        } else {
            console.warn("脚本执行了，但没有返回一个对象作为作用域。请确保脚本最后有 'return { ... };' 语句。将返回空作用域。");
            // 检查 componentScope 是否是 undefined，如果是，说明脚本可能缺少 return 语句
            if (typeof componentScope === 'undefined') {
                console.warn("提示：脚本似乎缺少最后的 'return { ... };' 语句。");
            }
            return {}; // 返回空对象以防后续代码出错
        }
    } catch (error) {
        console.error("执行组件脚本时出错:", error);
        console.error("脚本内容:\n", scriptContent);
        return {}; // 出错时也返回空对象
    }
}


/**
 * 编译模板节点，处理指令、绑定和事件
 * @param {Node} node 当前处理的 DOM 节点
 * @param {object} scope 组件的作用域对象
 * @param {object} directiveHandlers 包含指令处理函数的对象 (来自 directives.js)
 */
function compileNode(node, scope, directiveHandlers) {
    if (node.nodeType === Node.ELEMENT_NODE) {
        // 优先处理结构性指令 if, for
        const ifAttr = node.getAttribute('if');
        const forAttr = node.getAttribute('for');

        if (ifAttr !== null) {
            directiveHandlers.handleNueIf(node, ifAttr, scope, compileNode, directiveHandlers);
            return;
        }
        if (forAttr !== null) {
            directiveHandlers.handleNueFor(node, forAttr, scope, compileNode, directiveHandlers);
            return;
        }

        // 处理其他属性指令，如 html
        const htmlAttr = node.getAttribute('html');
        if (htmlAttr !== null) {
            // 调用指令处理器，它内部会处理表达式执行
            directiveHandlers.handleNueHtml(node, htmlAttr, scope);
        }


        // 处理事件绑定 @event
        const attrs = Array.from(node.attributes);
        attrs.forEach(attr => {
            if (attr.name.startsWith('@')) {
                const eventName = attr.name.substring(1);
                const handlerExpression = attr.value;
                node.addEventListener(eventName, (event) => {
                    console.log(`触发事件 ${eventName}，执行: ${handlerExpression}`);
                    try {
                        // --- 修改点：使用类似 evaluateExpression 的逻辑 ---
                        // 将 scope 和 event 合并到 context
                        const context = Object.create(scope);
                        context.event = event; // 添加 event 到 context

                        const argNames = ['context'];
                        const argValues = [context];

                        // 注意：事件处理器通常不需要 return，所以直接执行表达式
                        const handlerFunction = new Function(...argNames, `with(context) { ${handlerExpression} }`);
                        handlerFunction.apply(null, argValues);

                    } catch (error) {
                        console.error(`执行事件处理器 "${handlerExpression}" 出错:`, error);
                    }
                });
                node.removeAttribute(attr.name);
            }
        });

        // 递归处理子节点
        Array.from(node.childNodes).forEach(child => compileNode(child, scope, directiveHandlers));

    } else if (node.nodeType === Node.TEXT_NODE) {
        // 处理文本插值 {{ expression }}
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
            const placeholderNode = document.createTextNode('');
            segments.push(placeholderNode);

            createEffect(() => {
                try {
                    // --- 修改点：使用类似 evaluateExpression 的逻辑 ---
                    const context = scope; // 文本插值通常不需要额外参数
                    const argNames = ['context'];
                    const argValues = [context];

                    const valueFunction = new Function(...argNames, `with(context) { return ${expression}; }`);
                    const value = valueFunction.apply(null, argValues);

                    placeholderNode.textContent = value === undefined || value === null ? '' : String(value);
                } catch (error) {
                    console.error(`计算表达式 "{{${expression}}}" 出错:`, error);
                    placeholderNode.textContent = `{{Error: ${error.message}}}`;
                }
            });
            lastIndex = regex.lastIndex;
        }
        if (lastIndex < text.length) {
            segments.push(document.createTextNode(text.substring(lastIndex)));
        }

        if (segments.length > 0) {
            segments.forEach(segment => node.parentNode?.insertBefore(segment, node));
            node.parentNode?.removeChild(node);
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
 * 加载、编译并挂载组件到目标元素
 * @param {string} componentUrl .nue 文件的 URL
 * @param {string} targetSelector CSS 选择器，指定挂载的目标元素
 */
async function mountComponent(componentUrl, targetSelector) {
    console.log(`开始挂载组件: ${componentUrl} 到 ${targetSelector}`);
    const targetElement = document.querySelector(targetSelector);
    if (!targetElement) {
        console.error(`挂载失败：找不到目标元素 "${targetSelector}"`);
        return;
    }

    // 检查指令处理器是否已加载
    if (typeof window.NueDirectives === 'undefined') {
         console.error("指令处理器 (directives.js) 未加载！");
         targetElement.innerHTML = `<p style="color: red;">错误：directives.js 未加载</p>`;
         return;
    }

    try {
        // 1. 加载组件文件 (使用缓存)
        let componentText;
        let cacheEntry = componentCache.get(componentUrl);
        if (cacheEntry && cacheEntry.text) {
            componentText = cacheEntry.text;
            console.log(`从缓存加载 ${componentUrl}`);
        } else {
            console.log(`正在加载 ${componentUrl}...`);
            const response = await fetch(componentUrl);
            if (!response.ok) throw new Error(`加载组件失败: ${response.status} ${response.statusText}`);
            componentText = await response.text();
            cacheEntry = componentCache.get(componentText) || {}; // 可能因内容相同命中缓存
            cacheEntry.text = componentText;
            componentCache.set(componentUrl, cacheEntry); // 用 URL 作为主键
            componentCache.set(componentText, cacheEntry); // 用内容作为次键
            console.log("组件加载完成.");
        }

        // 2. 解析组件结构 (使用缓存)
        const { template, script, style } = parseComponentStructure(componentText);

        // 3. 解析脚本 AST (使用缓存)
        let ast;
        if (cacheEntry.ast) {
            ast = cacheEntry.ast;
            console.log("从缓存获取脚本 AST");
        } else {
            ast = parseScriptWithAcorn(script);
            cacheEntry.ast = ast; // 缓存 AST
        }

        // 4. 执行脚本获取作用域 (每次挂载都执行以获取新的 Signal 实例)
        const componentScope = executeScript(script, ast);

        // 5. 编译模板 (传入指令处理器)
        console.log("开始编译模板...");
        const fragment = document.createDocumentFragment();
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = template.trim();
        while (tempDiv.firstChild) {
            fragment.appendChild(tempDiv.firstChild);
        }
        // 对 fragment 的顶级节点进行编译
        Array.from(fragment.childNodes).forEach(node => compileNode(node, componentScope, window.NueDirectives));
        console.log("模板编译完成.");


        // 6. 注入样式 (使用缓存检查)
        injectStyles(style, componentUrl);

        // 7. 挂载到目标元素
        targetElement.innerHTML = ''; // 清空目标元素
        targetElement.appendChild(fragment);
        console.log(`组件 ${componentUrl} 成功挂载到 ${targetSelector}`);

    } catch (error) {
        console.error(`挂载组件 ${componentUrl} 时发生错误:`, error);
        targetElement.innerHTML = `<pre style="color: red;">加载或编译组件失败:\n${error.message}\n${error.stack || ''}</pre>`;
    }
}

// 暴露核心 API
window.NueCore = {
    mountComponent,
    createSignal, // 暴露给 directives.js 或外部使用
    createEffect,  // 暴露给 directives.js 或外部使用
    compileNode    // 暴露给 directives.js 用于递归编译
};

console.log("core.js 加载完成，NueCore 对象已准备就绪。");

