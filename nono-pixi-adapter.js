// nono-pixi-adapter.js - 将 Pixi.js 集成为 Nono-JS 的异构组件

(function () {
    // 步骤 0: 确认核心库和 Pixi.js 已加载
    if (!window.NueCore || !window.PIXI) {
        console.error("Pixi适配器错误：核心库(nono-core.js)和PIXI库(pixi.js)必须先加载！");
        return;
    }

    const { createEffect, registerRendererComponent } = window.NueCore;

    // ==================================
    // 辅助函数 (findPixiApp 不再需要)
    // ==================================

    function applyPixiBaseProperties(instance, props) {
        const baseProps = ['x', 'y', 'rotation', 'alpha', 'angle', 'scaleX', 'scaleY', 'pivotX', 'pivotY', 'width', 'height', 'tint'];
        baseProps.forEach(propName => {
            const signal = props[propName];
            if (typeof signal === 'function') {
                createEffect(() => {
                    const value = signal();
                    if (value !== undefined) {
                        instance[propName] = value;
                    }
                });
            }
        });
        if (typeof props.scale === 'function') {
            createEffect(() => {
                const value = props.scale();
                if (typeof value === 'number') {
                    instance.scale.set(value, value);
                } else if (typeof value === 'object' && value !== null) {
                    instance.scale.set(value.x ?? 1, value.y ?? 1);
                }
            });
        }
    }

    function applyPixiEvents(instance, eventHandlers, scope) {
        const cleanupCallbacks = [];
        const eventMap = { click: 'pointerdown', pointerdown: 'pointerdown', pointerup: 'pointerup', pointermove: 'pointermove', pointerover: 'pointerover', pointerout: 'pointerout' };
        for (const eventName in eventHandlers) {
            const handler = eventHandlers[eventName];
            if (eventName === 'update' && typeof handler === 'function') {
                const tickerCallback = (ticker) => handler.call(scope, ticker);
                instance.__tickerCallback = tickerCallback;
                PIXI.Ticker.shared.add(tickerCallback);
                cleanupCallbacks.push(() => PIXI.Ticker.shared.remove(instance.__tickerCallback));
            } else if (eventMap[eventName]) {
                const pixiEventName = eventMap[eventName];
                const boundHandler = (event) => handler.call(scope, event);
                instance.on(pixiEventName, boundHandler);
                cleanupCallbacks.push(() => instance.off(pixiEventName, boundHandler));
            }
        }
        return () => cleanupCallbacks.forEach(cb => cb());
    }

    // ==================================
    // 基础配置对象
    // ==================================

    const pixiDisplayObjectConfig = {
        _initInstance(instance, props, parentInstance, scope, eventHandlers) {
            if (parentInstance) {
                parentInstance.addChild(instance);
            } else {
                console.error(`Pixi适配器错误：组件 <${instance.constructor.name}> 缺少父级容器。`);
            }
            instance.eventMode = 'static';
            applyPixiBaseProperties(instance, props);
            instance.__cleanupEvents = applyPixiEvents(instance, eventHandlers, scope);
        },
        destroy(instance) {
            if (typeof instance.__cleanupEvents === 'function') {
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

    // --- <pixi-app> 配置 (全新设计) ---
    const pixiAppConfig = {
        create(props, parentInstance, scope, eventHandlers, placeholder) {
            // parentInstance 应该为 null
            const canvas = document.createElement('canvas');
            placeholder.parentNode.insertBefore(canvas, placeholder);

            const app = new PIXI.Application();
            
            // 使用 Promise.resolve() 来处理异步的 init
            Promise.resolve().then(async () => {
                await app.init({
                    view: canvas,
                    width: props.width ? props.width() : 800,
                    height: props.height ? props.height() : 600,
                    backgroundColor: props.backgroundColor ? props.backgroundColor() : 0x1099bb,
                    autoDensity: true,
                    resolution: window.devicePixelRatio || 1,
                });
            });

            // 监听 props 变化来更新 app
            if (props.backgroundColor && typeof props.backgroundColor === 'function') {
                createEffect(() => {
                    const color = props.backgroundColor();
                    if (app.renderer) {
                       app.renderer.background.color = color;
                    }
                });
            }
            
            // 将 app 实例返回，它的 stage 将作为子组件的 parentInstance
            return app;
        },
        destroy(instance) {
            instance.destroy(true, true); // 销毁 app，包括 canvas
        },
        // App 本身没有可见性
        setVisibility(instance, isVisible) {}
    };

    // --- <pixi-container> 配置 ---
    const pixiContainerConfig = {
        create(props, parentInstance, scope, eventHandlers) {
            const instance = new PIXI.Container();
            // parentInstance 可能是 app.stage 或另一个 container
            this._initInstance(instance, props, parentInstance, scope, eventHandlers);
            return instance;
        },
        ...pixiDisplayObjectConfig
    };

    // --- <pixi-sprite> 配置 ---
    const pixiSpriteConfig = {
        create(props, parentInstance, scope, eventHandlers) {
            const instance = new PIXI.Sprite();
            this._initInstance(instance, props, parentInstance, scope, eventHandlers);
            const textureSignal = props.texture || props.image;
            if (typeof textureSignal === 'function') {
                createEffect(async () => {
                    const textureUrlOrKey = textureSignal();
                    if (textureUrlOrKey) {
                        try {
                            const texture = await PIXI.Assets.load(textureUrlOrKey);
                            instance.texture = texture;
                        } catch (e) {
                            console.error(`Pixi适配器错误：加载纹理 "${textureUrlOrKey}" 失败。`, e);
                        }
                    }
                });
            }
            const anchorSignal = props.anchor;
            if (typeof anchorSignal === 'function') {
                createEffect(() => {
                    const value = anchorSignal();
                    if (typeof value === 'number') {
                        instance.anchor.set(value, value);
                    } else if (typeof value === 'object' && value !== null) {
                        instance.anchor.set(value.x ?? 0.5, value.y ?? 0.5);
                    }
                });
            } else {
                instance.anchor.set(0.5);
            }
            return instance;
        },
        ...pixiDisplayObjectConfig
    };
    
    // --- <pixi-text> 配置 ---
    const pixiTextConfig = {
        create(props, parentInstance, scope, eventHandlers) {
            const textContent = props.text ? props.text() : '';
            const style = props.style ? props.style() : {};
            const instance = new PIXI.Text(textContent, style);
            this._initInstance(instance, props, parentInstance, scope, eventHandlers);
            if (props.text && typeof props.text === 'function') {
                createEffect(() => { instance.text = props.text() ?? ''; });
            }
            if (props.style && typeof props.style === 'function') {
                createEffect(() => { instance.style = props.style() ?? {}; });
            }
            if (props.anchor && typeof props.anchor === 'function') {
                 createEffect(() => {
                    const value = props.anchor();
                    if (typeof value === 'number') {
                        instance.anchor.set(value, value);
                    }
                });
            }
            return instance;
        },
        ...pixiDisplayObjectConfig
    };

    // ==================================
    // 注册所有组件
    // ==================================
    registerRendererComponent('pixi-app', pixiAppConfig);
    registerRendererComponent('pixi-container', pixiContainerConfig);
    registerRendererComponent('pixi-sprite', pixiSpriteConfig);
    registerRendererComponent('pixi-text', pixiTextConfig);

    console.log("Pixi.js 适配器加载完成，已注册 <pixi-app>, <pixi-container>, <pixi-sprite>, <pixi-text> 组件。");

})();
