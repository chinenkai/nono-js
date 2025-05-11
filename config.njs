// 文件名: config.njs
// 路径: (假设与 utils.njs 在同一目录，或者你能正确引用到)
console.log("--- config.njs executed ---"); // 调试信息，确认只执行一次

const appName = "NonoApp";
const defaultLocale = "zh-CN";

// 模拟一个异步获取配置的操作
await new Promise((resolve) => setTimeout(resolve, 50)); // 模拟网络延迟

return {
    appName,
    defaultLocale,
    getApiEndpoint: (service) => `https://api.example.com/${service}`,
};
