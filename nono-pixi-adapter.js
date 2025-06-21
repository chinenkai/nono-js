// nono-pixi-adapter.js - 将 Pixi.js 集成为 Nono-JS 的异构组件 (已重构)

(function () {
    // 步骤 0: 确认核心库和 Pixi.js 已加载
    if (!window.NueCore || !window.PIXI) {
        console.error("Pixi适配器错误：核心库(nono-core.js)和PIXI库(pixi.js)必须先加载！");
        return;
    }

    const { createEffect, registerRendererComponent } = window.NueCore;

    // ==================================
    // (重构) 统一的属性应用辅助函数
    // ==================================

    /**
     * 【Prop系统重构】将静态和动态属性应用到 Pixi 实例上。
     * 此函数现在假设 props 的值已经是正确的类型，由核心库的 processComponentProps 处理。
     * @param {PIXI.DisplayObject} instance - Pixi 实例。
     * @param {{static: object, dynamic: object}} props - 经过验证和转换的 props 对象。
     */
    function applyPixiProperties(instance, props) {
        const { static: staticProps, dynamic: dynamicProps } = props;

        // --- 1. 应用静态属性 (仅在创建时执行一次) ---
        // 直接赋值，因为类型已正确。
        for (const propName in staticProps) {
            const value = staticProps[propName];
            if (propName === "scale" || propName === "anchor") {
                const target = instance[propName];
                if (target) {
                    if (typeof value === "number") {
                        target.set(value, value);
                    } else if (typeof value === "object" && value !== null) {
                        target.set(value.x ?? target.x, value.y ?? target.y);
                    }
                }
            } else if (propName === "texture" || propName === "image") {
                // 静态纹理仍然需要异步加载
                if (value) {
                    PIXI.Assets.load(value)
                        .then((texture) => {
                            instance.texture = texture;
                        })
                        .catch((e) => console.error(`Pixi适配器错误：加载静态纹理 "${value}" 失败。`, e));
                }
            } else {
                instance[propName] = value;
            }
        }

        // --- 2. 应用动态属性 (通过一个合并的 Effect) ---
        createEffect(() => {
            for (const propName in dynamicProps) {
                const signal = dynamicProps[propName];
                const value = signal(); // 在 Effect 中读取 Signal 值以建立依赖

                if (value === undefined) continue;

                if (propName === "scale" || propName === "anchor") {
                    const target = instance[propName];
                    if (target) {
                        if (typeof value === "number") {
                            target.set(value, value);
                        } else if (typeof value === "object" && value !== null) {
                            target.set(value.x ?? target.x, value.y ?? target.y);
                        }
                    }
                } else if (propName === "texture" || propName === "image") {
                    if (value) {
                        PIXI.Assets.load(value)
                            .then((texture) => {
                                instance.texture = texture;
                            })
                            .catch((e) => console.error(`Pixi适配器错误：加载动态纹理 "${value}" 失败。`, e));
                    }
                } else {
                    // 其他常规属性直接赋值
                    instance[propName] = value;
                }
            }
        });
    }

    /**
     * (重构) 将事件处理器绑定到 Pixi 实例上。
     * 逻辑基本不变，但保持函数独立性以提高代码清晰度。
     * @param {PIXI.DisplayObject} instance - Pixi 实例。
     * @param {object} eventHandlers - 事件处理器映射。
     * @param {object} scope - 组件作用域。
     * @returns {Function} 一个清理函数，用于移除所有事件监听器。
     */
    function applyPixiEvents(instance, eventHandlers, scope) {
        const cleanupCallbacks = [];
        // 映射 Nono-JS 事件名到 Pixi.js 事件名
        const eventMap = {
            click: "pointerdown",
            pointerdown: "pointerdown",
            pointerup: "pointerup",
            pointermove: "pointermove",
            pointerover: "pointerover",
            pointerout: "pointerout",
        };

        for (const eventName in eventHandlers) {
            const handler = eventHandlers[eventName];
            if (typeof handler !== "function") continue;

            if (eventName === "update") {
                // 特殊处理 'update' 事件，将其绑定到全局 Ticker
                const tickerCallback = (ticker) => handler.call(scope, ticker);
                instance.__tickerCallback = tickerCallback; // 存储回调以便移除
                PIXI.Ticker.shared.add(tickerCallback);
                cleanupCallbacks.push(() => {
                    if (instance.__tickerCallback) {
                        PIXI.Ticker.shared.remove(instance.__tickerCallback);
                        delete instance.__tickerCallback;
                    }
                });
            } else if (eventMap[eventName]) {
                // 处理其他标准交互事件
                const pixiEventName = eventMap[eventName];
                // handler 已经由核心库绑定了正确的 scope，这里直接使用
                instance.on(pixiEventName, handler);
                cleanupCallbacks.push(() => instance.off(pixiEventName, handler));
            }
        }
        // 返回一个统一的清理函数
        return () => cleanupCallbacks.forEach((cb) => cb());
    }

    // ==================================
    // (重构) 基础配置对象
    // ==================================
    const pixiDisplayObjectConfig = {
        /**
         * (已修改) 统一的初始化方法，供所有 DisplayObject 类型的组件调用。
         * @param {PIXI.DisplayObject} instance - 新创建的 Pixi 实例。
         * @param {{static: object, dynamic: object}} props - 解析后的 props。
         * @param {RenderContext} context - 【已修改】当前的渲染上下文。
         * @param {object} scope - 组件作用域。
         * @param {object} eventHandlers - 事件处理器。
         */
        _initInstance(instance, props, context, scope, eventHandlers) {
            // 【已修改】从上下文中获取父级容器
            const parentContainer = context.get("pixi:parentContainer");

            if (parentContainer && typeof parentContainer.addChild === "function") {
                parentContainer.addChild(instance);
            } else {
                console.error(`Pixi适配器错误：组件 <${instance.constructor.name}> 缺少有效的父级容器(从上下文中未找到 'pixi:parentContainer')。`, parentContainer);
                return;
            }
            // 启用交互事件
            instance.eventMode = "static";

            // (重构) 调用新的统一属性应用函数
            applyPixiProperties(instance, props);

            // (重构) 调用事件应用函数，并存储清理回调
            instance.__cleanupEvents = applyPixiEvents(instance, eventHandlers, scope);
        },
        destroy(instance) {
            // 销毁时，执行事件清理
            if (typeof instance.__cleanupEvents === "function") {
                instance.__cleanupEvents();
            }
            // 销毁 Pixi 对象自身
            instance.destroy();
        },
        setVisibility(instance, isVisible) {
            instance.visible = isVisible;
        },
    };

    // ==================================
    // (重构) 具体组件配置
    // ==================================
    // --- <pixi-app> 配置 ---
    const pixiAppConfig = {
        // 【Prop系统新增】定义 Prop Schema
        props: {
            width: { type: Number, default: 800 },
            height: { type: Number, default: 600 },
            backgroundColor: { type: Number, default: 0x1099bb },
        },
        async create(props, context, scope, eventHandlers, placeholder) {
            // ... create 函数内部逻辑不变，但它现在接收的是处理过的 props
            if (!props || !props.static || !props.dynamic) {
                console.error("Pixi适配器错误：<pixi-app> 接收到的 props 格式不正确。");
                return null;
            }

            const canvas = document.createElement("canvas");
            const domParent = context.get("dom:parentElement");
            if (domParent) {
                domParent.insertBefore(canvas, placeholder);
            } else {
                console.error("Pixi适配器错误：<pixi-app> 无法找到用于挂载canvas的父级DOM元素。");
                return null;
            }

            const { static: staticProps, dynamic: dynamicProps } = props;

            const app = new PIXI.Application();

            await app.init({
                view: canvas,
                width: staticProps.width, // 直接使用，无需再转换或提供默认值
                height: staticProps.height,
                backgroundColor: staticProps.backgroundColor,
                autoDensity: true,
                resolution: window.devicePixelRatio || 1,
            });

            context.provide({
                "pixi:app": app,
                "pixi:renderer": app.renderer,
                "pixi:ticker": app.ticker,
                "pixi:parentContainer": app.stage,
            });

            createEffect(() => {
                if (dynamicProps.backgroundColor) {
                    const color = dynamicProps.backgroundColor();
                    if (app.renderer && color !== undefined) {
                        app.renderer.background.color = color;
                    }
                }
                if (dynamicProps.width || dynamicProps.height) {
                    const newWidth = dynamicProps.width ? dynamicProps.width() : app.renderer.width;
                    const newHeight = dynamicProps.height ? dynamicProps.height() : app.renderer.height;
                    if (app.renderer && (newWidth !== app.renderer.width || newHeight !== app.renderer.height)) {
                        app.renderer.resize(newWidth, newHeight);
                    }
                }
            });

            return app;
        },
        // ... destroy 和 setVisibility 不变
        destroy(instance) {
            instance.destroy(true, true);
        },
        setVisibility(instance, isVisible) {
            instance.view.style.display = isVisible ? "" : "none";
        },
    };

    // --- <pixi-container> 配置 ---
    const pixiContainerConfig = {
        // 【Prop系统新增】定义 Prop Schema
        props: {
            x: { type: Number, default: 0 },
            y: { type: Number, default: 0 },
            rotation: { type: Number, default: 0 },
            alpha: { type: Number, default: 1 },
        },
        async create(props, context, scope, eventHandlers) {
            const instance = new PIXI.Container();
            this._initInstance(instance, props, context, scope, eventHandlers);
            context.provide({
                "pixi:parentContainer": instance,
            });
            return instance;
        },
        ...pixiDisplayObjectConfig,
    };

    // --- <pixi-sprite> 配置 ---
    const pixiSpriteConfig = {
        // 【Prop系统新增】定义 Prop Schema
        props: {
            x: { type: Number, default: 0 },
            y: { type: Number, default: 0 },
            texture: { type: String, required: true },
            tint: { type: Number, default: 0xffffff },
            scale: { type: [Number, Object], default: 1 },
            anchor: { type: [Number, Object], default: 0.5 },
            rotation: { type: Number, default: 0 },
            alpha: { type: Number, default: 1 },
        },
        async create(props, context, scope, eventHandlers) {
            const instance = new PIXI.Sprite();
            this._initInstance(instance, props, context, scope, eventHandlers);
            return instance;
        },
        ...pixiDisplayObjectConfig,
    };

    // --- <pixi-text> 配置 ---
    const pixiTextConfig = {
        // 【Prop系统新增】定义 Prop Schema
        props: {
            x: { type: Number, default: 0 },
            y: { type: Number, default: 0 },
            text: { type: String, default: "" },
            style: { type: Object, default: () => ({}) }, // 默认值可以是函数，返回新对象以避免引用问题
            anchor: { type: [Number, Object], default: 0.5 },
            rotation: { type: Number, default: 0 },
            alpha: { type: Number, default: 1 },
        },
        async create(props, context, scope, eventHandlers) {
            const instance = new PIXI.Text();
            this._initInstance(instance, props, context, scope, eventHandlers);
            return instance;
        },
        ...pixiDisplayObjectConfig,
    };

    // ==================================
    // 注册所有组件
    // ==================================
    registerRendererComponent("pixi-app", pixiAppConfig);
    registerRendererComponent("pixi-container", pixiContainerConfig);
    registerRendererComponent("pixi-sprite", pixiSpriteConfig);
    registerRendererComponent("pixi-text", pixiTextConfig);

    console.log("Pixi.js 适配器加载完成 (已重构)，已注册 <pixi-app>, <pixi-container>, <pixi-sprite>, <pixi-text> 组件。");
})();
