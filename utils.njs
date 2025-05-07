// 文件名: utils.njs
// 路径: (假设与 demo.nue 和 child-component.nue 在同一目录，或可相对访问)

console.log('--- utils.njs executed ---'); // 调试信息，确认只执行一次

// 使用顶层 await 直接导入 config.njs
const config = await importNjs('./config.njs'); // 路径相对于 utils.njs

console.log('--- utils.njs: config loaded ---', config);

function formatDate(date = new Date()) {
    // 使用 config 中的 locale (虽然这里没实际用，仅作演示)
    console.log(`Formatting date with locale (from config): ${config.defaultLocale}`);
    const options = { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' };
    return new Intl.DateTimeFormat(config.defaultLocale, options).format(date);
}

function greet(name) {
    return `你好, ${name}! 欢迎来到 ${config.appName}.`;
}

// 模拟一个异步的实用函数
async function fetchData(resource) {
    console.log(`Fetching data for: ${resource} from ${config.getApiEndpoint(resource)}`);
    // 模拟 API 调用
    await new Promise(resolve => setTimeout(resolve, 100 + Math.random() * 200));
    return {
        resource: resource,
        data: `这是 ${resource} 的模拟数据 (来自 ${config.appName})`,
        timestamp: Date.now()
    };
}

// 导出模块内容
return {
    formatDate,
    greet,
    fetchData,
    appNameFromConfig: config.appName // 直接暴露一个来自依赖模块的值
};
