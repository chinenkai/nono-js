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
     * (重构) 将静态和动态属性应用到 Pixi 实例上。
     * 这个函数现在能处理静态值，并将所有动态属性的更新合并到一个 Effect 中。
     * @param {PIXI.DisplayObject} instance - Pixi 实例。
     * @param {{static: object, dynamic: object}} props - 由核心库 parseComponentProps 解析出的 props 对象。
     */
    function applyPixiProperties(instance, props) {
        const { static: staticProps, dynamic: dynamicProps } = props;

        // --- 1. 应用静态属性 (仅在创建时执行一次) ---
        // 静态属性直接赋值，无需创建 Effect。
        for (const propName in staticProps) {
            const value = staticProps[propName];
            // 对一些特殊属性进行处理
            if (propName === "scale") {
                const scaleValue = parseFloat(value);
                if (!isNaN(scaleValue)) {
                    instance.scale.set(scaleValue, scaleValue);
                }
            } else if (propName === "anchor") {
                const anchorValue = parseFloat(value);
                if (!isNaN(anchorValue)) {
                    instance.anchor?.set(anchorValue, anchorValue);
                }
            } else if (propName === "texture" || propName === "image") {
                // 静态纹理也通过异步加载设置
                PIXI.Assets.load(value)
                    .then((texture) => {
                        instance.texture = texture;
                    })
                    .catch((e) => console.error(`Pixi适配器错误：加载静态纹理 "${value}" 失败。`, e));
            } else if (propName === "text") {
                instance.text = value;
            } else if (propName === "style") {
                // 静态 style 属性需要是 JSON 字符串
                try {
                    instance.style = JSON.parse(value);
                } catch (e) {
                    console.warn(`Pixi适配器警告：无法解析静态 style 属性 JSON 字符串: "${value}"`);
                }
            } else {
                // 其他常规属性直接赋值
                instance[propName] = value;
            }
        }

        // --- 2. 应用动态属性 (通过一个合并的 Effect) ---
        // 将所有动态属性的更新逻辑合并到一个 createEffect 中，以优化性能。
        createEffect(() => {
            for (const propName in dynamicProps) {
                const signal = dynamicProps[propName];
                const value = signal(); // 在 Effect 中读取 Signal 值以建立依赖

                if (value === undefined) continue; // 如果 Signal 未定义，则跳过

                // 根据属性名应用值
                if (propName === "scale") {
                    if (typeof value === "number") {
                        instance.scale.set(value, value);
                    } else if (typeof value === "object" && value !== null) {
                        instance.scale.set(value.x ?? 1, value.y ?? 1);
                    }
                } else if (propName === "anchor") {
                    if (instance.anchor) {
                        if (typeof value === "number") {
                            instance.anchor.set(value, value);
                        } else if (typeof value === "object" && value !== null) {
                            instance.anchor.set(value.x ?? 0.5, value.y ?? 0.5);
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
                } else if (propName === "text") {
                    instance.text = value ?? "";
                } else if (propName === "style") {
                    instance.style = value ?? {};
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
        /**
         * @param {object} props - 解析后的 props 对象。
         * @param {RenderContext} context - 【已修改】当前的渲染上下文。
         * @param {object} scope - 组件作用域。
         * @param {object} eventHandlers - 事件处理器。
         * @param {Comment} placeholder - DOM 中的占位符注释节点。
         */
        create(props, context, scope, eventHandlers, placeholder) {
            // (新增) 健壮性检查
            if (!props || !props.static || !props.dynamic) {
                console.error("Pixi适配器错误：<pixi-app> 接收到的 props 格式不正确。应为 { static: {}, dynamic: {} }。实际接收到:", props);
                return null; // 提前返回，防止后续错误
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

            // 使用静态或默认值进行初始化
            const app = new PIXI.Application();

            // 【错误修正：同步提供依赖】
            // 必须在异步 init 之前，同步地向上下文中提供子组件所依赖的资源。
            // PIXI.Application 在实例化后，app.stage 就已经可用了。
            context.provide({
                "pixi:app": app,
                "pixi:parentContainer": app.stage, // 同步提供 stage 作为父容器
            });

            // 使用 Promise.resolve() 来处理异步的 init
            Promise.resolve().then(async () => {
                await app.init({
                    view: canvas,
                    width: parseInt(staticProps.width) || 800,
                    height: parseInt(staticProps.height) || 600,
                    backgroundColor: staticProps.backgroundColor ? parseInt(staticProps.backgroundColor, 16) : 0x1099bb, // 确保颜色是数字
                    autoDensity: true,
                    resolution: window.devicePixelRatio || 1,
                });

                // 【错误修正：异步提供其余依赖】
                // 在 app.init 完成后，renderer 和 ticker 才完全准备好，此时再提供它们。
                // 虽然当前子组件可能不直接用，但这是更健壮的做法。
                context.provide({
                    "pixi:renderer": app.renderer,
                    "pixi:ticker": app.ticker,
                });
            });

            // 监听动态 props 变化来更新 app
            createEffect(() => {
                if (dynamicProps.backgroundColor) {
                    const color = dynamicProps.backgroundColor();
                    // 确保 renderer 存在后再操作
                    if (app.renderer && color !== undefined) {
                        app.renderer.background.color = color;
                    }
                }
                if (dynamicProps.width || dynamicProps.height) {
                    const newWidth = dynamicProps.width ? dynamicProps.width() : app.renderer?.width || parseInt(staticProps.width);
                    const newHeight = dynamicProps.height ? dynamicProps.height() : app.renderer?.height || parseInt(staticProps.height);
                    // 确保 renderer 存在后再操作
                    if (app.renderer && (newWidth !== app.renderer.width || newHeight !== app.renderer.height)) {
                        app.renderer.resize(newWidth, newHeight);
                    }
                }
            });

            return app;
        },
        destroy(instance) {
            instance.destroy(true, true); // 销毁 app，包括 canvas
        },
        setVisibility(instance, isVisible) {
            // App 的可见性由其 canvas 元素的 display 属性控制
            instance.view.style.display = isVisible ? "" : "none";
        },
    };

    // --- <pixi-container> 配置 ---
    const pixiContainerConfig = {
        create(props, context, scope, eventHandlers) {
            const instance = new PIXI.Container();
            // 【已修改】传递 context 给 _initInstance
            this._initInstance(instance, props, context, scope, eventHandlers);

            // 【核心修改】<pixi-container> 消费 'pixi:parentContainer' 后，
            // 又为自己的子节点提供了新的 'pixi:parentContainer'，即它自身。
            context.provide({
                "pixi:parentContainer": instance,
            });

            return instance;
        },
        ...pixiDisplayObjectConfig,
    };

    const pixiSpriteConfig = {
        create(props, context, scope, eventHandlers) {
            const instance = new PIXI.Sprite();
            // 【已修改】传递 context 给 _initInstance
            this._initInstance(instance, props, context, scope, eventHandlers);

            // 特殊处理 anchor 的默认值，如果用户没有提供静态或动态的 anchor
            if (!props.static.anchor && !props.dynamic.anchor) {
                instance.anchor.set(0.5);
            }

            return instance;
        },
        ...pixiDisplayObjectConfig,
    };

    const pixiTextConfig = {
        create(props, context, scope, eventHandlers) {
            // 文本和样式将由统一的 applyPixiProperties 处理
            const instance = new PIXI.Text();
            // 【已修改】传递 context 给 _initInstance
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
