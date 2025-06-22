# Nono.js 框架使用说明文档

本文档旨在提供对 Nono.js 框架各项功能的精确、详尽且直接的使用指导。本文档的目标是成为开发者使用此框架的最终参考。

## 目录

1.  [核心理念](#1-核心理念)
2.  [快速入门：项目设置](#2-快速入门项目设置)
3.  [组件 (`.nue` 文件) 结构](#3-组件-nue-文件-结构)
    *   [3.1 自动注入的作用域](#31-自动注入的作用域)
4.  [核心反应系统](#4-核心反应系统)
    *   [4.1 `createSignal`: 定义反应式状态](#41-createsignal-定义反应式状态)
    *   [4.2 `createWatch`: 侦听状态变化](#42-createwatch-侦听状态变化)
5.  [模板指令详解](#5-模板指令详解)
    *   [5.1 文本插值: `{{ }}`](#51-文本插值--)
    *   [5.2 属性绑定: `:attribute`](#52-属性绑定-attribute)
    *   [5.3 事件处理: `@event`](#53-事件处理-event)
    *   [5.4 条件渲染: `n-if`](#54-条件渲染-n-if)
    *   [5.5 条件显示: `n-show`](#55-条件显示-n-show)
    *   [5.6 列表渲染: `n-for`](#56-列表渲染-n-for)
    *   [5.7 双向数据绑定: `n-model`](#57-双向数据绑定-n-model)
    *   [5.8 HTML 内容注入: `n-html`](#58-html-内容注入-n-html)
6.  [组件生命周期](#6-组件生命周期)
    *   [6.1 `onMount`: 挂载完成](#61-onmount-挂载完成)
    *   [6.2 `onUnmount`: 卸载之前](#62-onunmount-卸载之前)
7.  [组件化与通信](#7-组件化与通信)
    *   [7.1 使用子组件](#71-使用子组件)
    *   [7.2 Props: 父向子通信](#72-props-父向子通信)
    *   [7.3 事件 (Events): 子向父通信](#73-事件-events-子向父通信)
    *   [7.4 插槽 (Slots): 内容分发](#74-插槽-slots-内容分发)
8.  [模块化 (`.njs` 文件)](#8-模块化-njs-文件)
9.  [客户端路由](#9-客户端路由)
    *   [9.1 `createUrlWatch`: 监听路由变化](#91-createurlwatch-监听路由变化)
    *   [9.2 `navigateTo`: 命令式导航](#92-navigateto-命令式导航)
10. [性能优化与部署](#10-性能优化与部署)
    *   [10.1 `exportDependencyBundle`: 依赖预打包](#101-exportdependencybundle-依赖预打包)

---

## 1. 核心理念

Nono.js 是一个极简的、无需构建工具的前端框架。其设计哲学是：

*   **零依赖**：不依赖 Node.js 或任何构建工具链。
*   **单文件组件**：将结构 (HTML)、逻辑 (JS) 和样式 (CSS) 封装在单一的 `.nue` 文件中。
*   **反应式**：通过 Signal 实现数据驱动视图的自动更新。

## 2. 快速入门：项目设置

一个基本的 Nono.js 应用由以下部分组成：

1.  **`index.html`**：应用的入口 HTML 文件。
2.  **`nono-core.js`**：框架的核心反应式系统和组件加载器。
3.  **`nono-directives.js`**：框架的模板指令处理器。
4.  **组件文件 (`.nue`)**：应用的各个部分。

**设置步骤 (`demo.html` 示例):**

```html
<!doctype html>
<html>
<head>
    <meta charset="UTF-8" />
    <title>Nono.js App</title>
</head>
<body>
    <div id="app"><p>正在加载...</p></div>
    <script src="nono-core.js"></script>
    <script src="nono-directives.js"></script>
    <script>
        document.addEventListener("DOMContentLoaded", () => {
            window.NueCore.init("app", "demo.nue", "1.0.0");
        });
    </script>
</body>
</html>
```

## 3. 组件 (`.nue` 文件) 结构

每个 `.nue` 文件都是一个独立的组件，由三个可选部分组成：`<template>`, `<script>`, `<style>`。

### 3.1 自动注入的作用域

在每个组件的 `<script>` 块内部，框架会自动注入一系列全局可用的函数和对象。你无需手动导入它们，可以直接使用：

*   **`createSignal(initialValue)`**: 创建反应式状态。
*   **`createWatch(signal, callback, options)`**: 侦听状态变化。
*   **`createUrlWatch(regex, onMatch, onUnmatch)`**: 监听 URL 变化。
*   **`navigateTo(path)`**: 命令式导航。
*   **`importNjs(path)`**: 异步导入 `.njs` 模块。
*   **`props`**: 包含父组件传入属性的对象。
*   **`emit(eventName, payload)`**: 向父组件发射事件的函数。
*   **`createEffect(fn)`**: (高级) 创建一个响应式副作用。

## 4. 核心反应系统

### 4.1 `createSignal`: 定义反应式状态

`createSignal` 是创建反应式数据的唯一方式。

```javascript
// script
const count = createSignal(0); // 创建

const readValue = () => {
    console.log(count()); // 读取: 0
};

const writeValue = () => {
    count(10); // 写入新值
    console.log(count()); // 读取: 10
};
```

### 4.2 `createWatch`: 侦听状态变化

`createWatch` 用于在某个 Signal 发生变化时执行一个副作用函数。

```javascript
// script
const name = createSignal("Alice");

// 创建侦听器
const stopWatching = createWatch(name, (newValue, oldValue) => {
    console.log(`名字从 ${oldValue} 变成了 ${newValue}`);
});

// 触发变化
name("Bob"); // 控制台输出: "名字从 Alice 变成了 Bob"

// 停止侦听
// stopWatching();
```

## 5. 模板指令详解

### 5.1 文本插值: `{{ }}`

用于在模板中显示 JavaScript 表达式的结果。

```html
<template>
    <p>当前计数值: {{ count }}</p>
    <p>计数值的两倍: {{ count * 2 }}</p>
</template>
<script>
    const count = createSignal(5);
    return { count };
</script>
```

### 5.2 属性绑定: `:attribute`

用于动态地将一个或多个属性绑定到元素上。

```html
<template>
    <!-- 根据 isButtonDisabled 的值 (true/false) 动态设置 disabled 属性 -->
    <button :disabled="isButtonDisabled">动态按钮</button>

    <!-- 根据 isHighlighted 的值动态添加或移除 'highlight' 类 -->
    <p :class="{ highlight: isHighlighted }">动态高亮文本</p>

    <!-- 动态设置 style -->
    <p :style="{ color: textColor, fontSize: '16px' }">动态样式文本</p>
</template>
<script>
    const isButtonDisabled = createSignal(true);
    const isHighlighted = createSignal(true);
    const textColor = createSignal("blue");
    return { isButtonDisabled, isHighlighted, textColor };
</script>
```

### 5.3 事件处理: `@event`

用于监听 DOM 事件并执行相应的方法。

```html
<template>
    <p>点击次数: {{ clickCount }}</p>
    <!-- 点击时直接修改 Signal -->
    <button @click="clickCount(clickCount() + 1)">点我</button>
    <!-- 点击时调用组件方法 -->
    <button @click="resetCounter">重置</button>
</template>
<script>
    const clickCount = createSignal(0);
    const resetCounter = () => {
        clickCount(0);
    };
    return { clickCount, resetCounter };
</script>
```

### 5.4 条件渲染: `n-if`

根据表达式的真假值，在 DOM 中**创建或销毁**一个元素。

```html
<template>
    <button @click="toggleVisibility">切换</button>
    <p n-if="isVisible">现在你看到我了。</p>
</template>
<script>
    const isVisible = createSignal(true);
    const toggleVisibility = () => isVisible(!isVisible());
    return { isVisible, toggleVisibility };
</script>
```

### 5.5 条件显示: `n-show`

根据表达式的真假值，通过 CSS 的 `display` 属性**显示或隐藏**一个元素。

```html
<template>
    <button @click="toggleDisplay">切换</button>
    <!-- 这个 p 元素始终在 DOM 中 -->
    <p n-show="isDisplayed">我在这里，只是可能看不见。</p>
</template>
<script>
    const isDisplayed = createSignal(true);
    const toggleDisplay = () => isDisplayed(!isDisplayed());
    return { isDisplayed, toggleDisplay };
</script>
```

### 5.6 列表渲染: `n-for`

用于根据一个数组渲染一个列表。必须提供一个唯一的 `:key`。

```html
<template>
    <ul>
        <li n-for="fruit in fruits" :key="fruit.id">
            {{ fruit.name }}
        </li>
    </ul>
</template>
<script>
    const fruits = createSignal([
        { id: 1, name: "苹果" },
        { id: 2, name: "香蕉" },
    ]);
    return { fruits };
</script>
```

### 5.7 双向数据绑定: `n-model`

在表单输入元素上创建双向数据绑定。

```html
<template>
    <input type="text" n-model="username" placeholder="输入你的名字">
    <p>你好, {{ username }}</p>
</template>
<script>
    const username = createSignal("访客");
    return { username };
</script>
```

### 5.8 HTML 内容注入: `n-html`

用于将一个字符串作为原始 HTML 渲染到元素中。**请仅对可信内容使用此指令以避免 XSS 风险。**

```html
<template>
    <div n-html="htmlContent"></div>
</template>
<script>
    const htmlContent = createSignal("<strong>加粗文本</strong>");
    return { htmlContent };
</script>
```

## 6. 组件生命周期

生命周期钩子是组件在特定阶段自动执行的函数。你需要在 `<script>` 中定义并导出它们。

### 6.1 `onMount`: 挂载完成

在组件首次被渲染并插入 DOM 后执行。这是发起网络请求、初始化第三方库或设置复杂监听器的理想位置。

```javascript
// script
const onMount = async () => {
    console.log("组件已挂载到 DOM！");
    // 示例: 获取初始数据
    const response = await fetch("https://api.example.com/data");
    const data = await response.json();
    // ... 使用数据更新状态 ...
};

return { onMount };
```

### 6.2 `onUnmount`: 卸载之前

在组件从 DOM 中移除前执行。**必须**在此处清理在 `onMount` 中创建的副作用（如定时器、手动添加的事件监听器、WebSocket 连接等），以防止内存泄漏。

```javascript
// script
let timerId = null;

const onMount = () => {
    timerId = setInterval(() => console.log("时间流逝..."), 1000);
};

const onUnmount = () => {
    console.log("组件即将卸载，清理定时器。");
    clearInterval(timerId); // 清理工作至关重要
};

return { onMount, onUnmount };
```

## 7. 组件化与通信

### 7.1 使用子组件

通过在模板中声明一个带 `src` 属性的标签来加载和使用子组件。

```html
<!-- parent.nue -->
<template>
    <h1>我是父组件</h1>
    <!-- 标签名 'user-profile' 是自定义的，src 指向文件路径 -->
    <user-profile src="./child-profile.nue"></user-profile>
</template>
```

### 7.2 Props: 父向子通信

父组件通过属性将数据传递给子组件。模板中使用 `kebab-case`，脚本中通过 `props.camelCase` 访问。

```html
<!-- parent.nue -->
<template>
    <user-profile
        src="./child-profile.nue"
        user-name="Alice"
        :user-age="30"
    ></user-profile>
</template>
```

```html
<!-- child-profile.nue -->
<template>
    <p>姓名: {{ props.userName }}</p> <!-- 访问 props.userName -->
    <p>年龄: {{ props.userAge }}</p>  <!-- 访问 props.userAge -->
</template>
<script>
    // props 对象被自动注入，只需导出即可在模板中使用
    return { props };
</script>
```

### 7.3 事件 (Events): 子向父通信

子组件通过 `emit` 函数触发事件，父组件使用 `@event-name` 监听。`$event` 代表传递的数据。

```html
<!-- child-button.nue -->
<template>
    <button @click="sendData">通知父组件</button>
</template>
<script>
    const sendData = () => {
        // emit('事件名', 数据载荷)
        emit('user-click', { message: '按钮被点击了', timestamp: Date.now() });
    };
    return { sendData };
</script>
```

```html
<!-- parent.nue -->
<template>
    <child-button src="./child-button.nue" @user-click="handleChildClick($event)"></child-button>
    <p>从子组件收到的消息: {{ childMessage }}</p>
</template>
<script>
    const childMessage = createSignal('等待中...');
    const handleChildClick = (payload) => { // payload 就是 $event
        childMessage(payload.message);
    };
    return { childMessage, handleChildClick };
</script>
```

### 7.4 插槽 (Slots): 内容分发

允许父组件将内容“投影”到子组件的指定位置。**关键：插槽内容的作用域属于父组件。**

```html
<!-- card-layout.nue (子组件) -->
<template>
    <div class="card">
        <header class="card-header">
            <slot name="header">默认标题</slot> <!-- 具名插槽 -->
        </header>
        <main class="card-body">
            <slot>默认内容</slot> <!-- 默认插槽 -->
        </main>
    </div>
</template>
```

```html
<!-- parent.nue (父组件) -->
<template>
    <card-layout src="./card-layout.nue">
        <!-- 填充 "header" 插槽 -->
        <template slot="header">
            <h3>我的卡片标题 (来自父组件)</h3>
        </template>

        <!-- 填充默认插槽 -->
        <p>这是卡片的主要内容，其中可以包含父组件的状态: {{ parentState }}</p>
    </card-layout>
</template>
<script>
    const parentState = createSignal("Hello World");
    return { parentState };
</script>
```

## 8. 模块化 (`.njs` 文件)

用于封装可复用的 JavaScript 逻辑。支持顶层 `await`，且每个模块在应用中只执行一次（单例模式）。

```javascript
// utils.njs
function formatDate(date) {
    return new Intl.DateTimeFormat().format(date);
}

// 使用 return 导出
return {
    formatDate,
    API_ENDPOINT: 'https://api.example.com'
};
```

```html
<!-- my-component.nue -->
<template>
    <p>今天的日期: {{ today }}</p>
</template>
<script>
    const today = createSignal('加载中...');
    const onMount = async () => {
        const utils = await importNjs('./utils.njs');
        today(utils.formatDate(new Date()));
        console.log(utils.API_ENDPOINT);
    };
    return { today, onMount };
</script>
```

## 9. 客户端路由

### 9.1 `createUrlWatch`: 监听路由变化

监听 URL 变化。当 URL 匹配或不再匹配提供的正则表达式时，执行相应回调。

```html
<template>
    <nav>
        <a href="#/user/123">用户123</a>
        <a href="#/user/456">用户456</a>
    </nav>
    <p>{{ routeInfo }}</p>
</template>
<script>
    const routeInfo = createSignal('当前不在用户页面');
    const onMount = () => {
        createUrlWatch(
            /#\/user\/(\d+)/, // 匹配 /user/ followed by digits
            (url) => { // onMatch
                const userId = url.match(/#\/user\/(\d+)/)[1];
                routeInfo(`正在查看用户 ID: ${userId}`);
            },
            () => { // onUnmatch
                routeInfo('已离开用户页面');
            }
        );
    };
    return { routeInfo, onMount };
</script>
```

### 9.2 `navigateTo`: 命令式导航

以编程方式跳转到新路径，无需用户点击链接。

```html
<template>
    <button @click="goToHome">返回首页</button>
</template>
<script>
    const goToHome = () => {
        navigateTo('#/home');
    };
    return { goToHome };
</script>
```

## 10. 性能优化与部署

### 10.1 `exportDependencyBundle`: 依赖预打包

**目的**：将所有 `.nue` 和 `.njs` 依赖打包成单个文件，大幅减少生产环境的 HTTP 请求，加速初始加载。

**原理**：从根组件开始，抓取所有依赖并生成一个 `bundle.js` 文件。应用加载此文件后，将从内存读取组件，不再发起网络请求。

#### 步骤 1: 生成依赖包 (开发时)

在你的应用页面，打开浏览器开发者工具的控制台，执行以下命令：

```javascript
// 在浏览器控制台执行
window.NueCore.exportDependencyBundle("demo.nue");
```
浏览器将自动下载一个 `nue-data-bundle.js` 文件。

#### 步骤 2: 使用依赖包 (生产环境)

将下载的 `nue-data-bundle.js` 文件放到你的项目目录中，并在主 HTML 文件中引入它。

```html
<!-- index.html (生产环境) -->
<!doctype html>
<html>
<body>
    <div id="app"></div>

    <!-- 核心库 -->
    <script src="nono-core.js"></script>
    <script src="nono-directives.js"></script>

    <!-- 【关键】在此处引入预打包的依赖文件 -->
    <script src="nue-data-bundle.js"></script>

    <!-- 启动应用 -->
    <script>
        document.addEventListener("DOMContentLoaded", () => {
            window.NueCore.init("app", "demo.nue");
        });
    </script>
</body>
</html>
```