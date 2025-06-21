// nono-pixi-adapter.js - 最终修复版，适配统一的响应式 Props 系统

(function () {
    // 步骤 0: 确认核心库和 Pixi.js 已加载
    if (!window.NueCore || !window.PIXI) {
        console.error("Pixi适配器错误：核心库(nono-core.js)和PIXI库(pixi.js)必须先加载！");
        return;
    }

    const { createEffect, registerRendererComponent } = window.NueCore;

    // ==================================
    // 统一的属性应用辅助函数
    // ==================================

    /**
     * 【已重构】将扁平化的响应式 props 对象应用到 Pixi 实例上。
     * @param {PIXI.DisplayObject} instance - Pixi 实例。
     * @param {object} props - 由核心库处理过的、带有响应式 getter 的扁平 props 对象。
     */
    function applyPixiProperties(instance, props) {
        // 内部辅助函数，用于将单个属性值应用到 Pixi 实例上
        const applyValue = (propName, value) => {
            if (value === undefined) return;

            // 特殊处理 scale 和 anchor，它们是 Point 对象
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
                // 纹理需要异步加载
                if (value && instance.texture?.label !== value) { // 避免重复加载相同纹理
                    PIXI.Assets.load(value)
                        .then((texture) => {
                            instance.texture = texture;
                        })
                        .catch((e) => console.error(`Pixi适配器错误：加载纹理 "${value}" 失败。`, e));
                }
            } else {
                // 其他常规属性直接赋值
                instance[propName] = value;
            }
        };

        // 【核心】创建一个 effect，遍历所有 props。
        // 当访问 props[propName] 时，如果它是一个响应式 getter，依赖就会被自动收集。
        createEffect(() => {
            for (const propName in props) {
                // 访问属性会触发 getter，从而获取最新值并建立响应式链接
                const value = props[propName];
                applyValue(propName, value);
            }
        });
    }

    /**
     * 将事件处理器绑定到 Pixi 实例上 (此函数无需修改)。
     */
    function applyPixiEvents(instance, eventHandlers, scope) {
        const cleanupCallbacks = [];
        const eventMap = { click: "pointerdown", pointerdown: "pointerdown", pointerup: "pointerup", pointermove: "pointermove", pointerover: "pointerover", pointerout: "pointerout" };

        for (const eventName in eventHandlers) {
            const handler = eventHandlers[eventName];
            if (typeof handler !== "function") continue;

            if (eventName === "update") {
                const tickerCallback = (ticker) => handler.call(scope, ticker);
                instance.__tickerCallback = tickerCallback;
                PIXI.Ticker.shared.add(tickerCallback);
                cleanupCallbacks.push(() => {
                    if (instance.__tickerCallback) {
                        PIXI.Ticker.shared.remove(instance.__tickerCallback);
                        delete instance.__tickerCallback;
                    }
                });
            } else if (eventMap[eventName]) {
                const pixiEventName = eventMap[eventName];
                instance.on(pixiEventName, handler);
                cleanupCallbacks.push(() => instance.off(pixiEventName, handler));
            }
        }
        return () => cleanupCallbacks.forEach((cb) => cb());
    }

    // ==================================
    // 基础配置对象
    // ==================================
    const pixiDisplayObjectConfig = {
        _initInstance(instance, props, context, scope, eventHandlers) {
            const parentContainer = context.get("pixi:parentContainer");
            if (parentContainer && typeof parentContainer.addChild === "function") {
                parentContainer.addChild(instance);
            } else {
                console.error(`Pixi适配器错误：组件 <${instance.constructor.name}> 缺少有效的父级容器。`);
                return;
            }
            instance.eventMode = "static";

            // 【已修改】直接传递扁平的 props 对象
            applyPixiProperties(instance, props);
            instance.__cleanupEvents = applyPixiEvents(instance, eventHandlers, scope);
        },
        destroy(instance) {
            if (typeof instance.__cleanupEvents === "function") {
                instance.__cleanupEvents();
            }
            instance.destroy();
        },
        setVisibility(instance, isVisible) {
            instance.visible = isVisible;
        },
    };

    // ==================================
    // 具体组件配置
    // ==================================
    const pixiAppConfig = {
        props: {
            width: { type: Number, default: 800 },
            height: { type: Number, default: 600 },
            backgroundColor: { type: Number, default: 0x1099bb },
        },
        async create(props, context, scope, eventHandlers, placeholder) {
            const canvas = document.createElement("canvas");
            const domParent = context.get("dom:parentElement");
            if (domParent) {
                domParent.insertBefore(canvas, placeholder);
            } else {
                console.error("Pixi适配器错误：<pixi-app> 无法找到用于挂载canvas的父级DOM元素。");
                return null;
            }

            const app = new PIXI.Application();

            // 【已修改】直接从扁平的 props 对象获取初始值
            await app.init({
                view: canvas,
                width: props.width,
                height: props.height,
                backgroundColor: props.backgroundColor,
                autoDensity: true,
                resolution: window.devicePixelRatio || 1,
            });

            context.provide({
                "pixi:app": app,
                "pixi:renderer": app.renderer,
                "pixi:ticker": app.ticker,
                "pixi:parentContainer": app.stage,
            });

            // 【已修改】创建一个 effect 来响应式地更新 renderer 的属性
            createEffect(() => {
                const color = props.backgroundColor;
                if (app.renderer && app.renderer.background && color !== undefined) {
                    app.renderer.background.color = color;
                }
                
                const newWidth = props.width;
                const newHeight = props.height;
                if (app.renderer && (newWidth !== app.renderer.width || newHeight !== app.renderer.height)) {
                    app.renderer.resize(newWidth, newHeight);
                }
            });

            return app;
        },
        destroy(instance) {
            instance.destroy(true, true);
        },
        setVisibility(instance, isVisible) {
            instance.view.style.display = isVisible ? "" : "none";
        },
    };

    const pixiContainerConfig = {
        props: { x: { type: Number, default: 0 }, y: { type: Number, default: 0 }, rotation: { type: Number, default: 0 }, alpha: { type: Number, default: 1 } },
        async create(props, context, scope, eventHandlers) {
            const instance = new PIXI.Container();
            this._initInstance(instance, props, context, scope, eventHandlers);
            context.provide({ "pixi:parentContainer": instance });
            return instance;
        },
        ...pixiDisplayObjectConfig,
    };

    const pixiSpriteConfig = {
        props: { x: { type: Number, default: 0 }, y: { type: Number, default: 0 }, texture: { type: String, required: true }, tint: { type: Number, default: 0xffffff }, scale: { type: [Number, Object], default: 1 }, anchor: { type: [Number, Object], default: 0.5 }, rotation: { type: Number, default: 0 }, alpha: { type: Number, default: 1 } },
        async create(props, context, scope, eventHandlers) {
            const instance = new PIXI.Sprite();
            this._initInstance(instance, props, context, scope, eventHandlers);
            return instance;
        },
        ...pixiDisplayObjectConfig,
    };

    const pixiTextConfig = {
        props: { x: { type: Number, default: 0 }, y: { type: Number, default: 0 }, text: { type: String, default: "" }, style: { type: Object, default: () => ({}) }, anchor: { type: [Number, Object], default: 0.5 }, rotation: { type: Number, default: 0 }, alpha: { type: Number, default: 1 } },
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

    console.log("Pixi.js 适配器加载完成 (已适配统一 Props 系统)，已注册 <pixi-app>, <pixi-container>, <pixi-sprite>, <pixi-text> 组件。");
})();
