export class ImageGenerationManager {
    constructor() {
        this._sdModelsCache = null;
        this._sdModelsCacheTime = 0;
        this._sdModelsCacheTtl = 5 * 60 * 1000;
        this._apiBaseUrl = '';
        this._csrfToken = null;
        this._csrfTokenPromise = null;
    }

    _isSillyTavern() {
        try {
            return typeof window !== 'undefined' && window.location &&
                   window.location.port === '8000' ||
                   (typeof SillyTavern !== 'undefined');
        } catch (e) { return false; }
    }

    async _getCsrfToken() {
        if (this._csrfToken) return this._csrfToken;
        if (this._csrfTokenPromise) return this._csrfTokenPromise;
        this._csrfTokenPromise = (async () => {
            try {
                const resp = await fetch('/csrf-token');
                const data = await resp.json();
                this._csrfToken = data.token;
                return this._csrfToken;
            } catch (e) {
                this._csrfTokenPromise = null;
                return null;
            }
        })();
        return this._csrfTokenPromise;
    }

    async _sdProxyRequest(endpoint, body = {}, method = 'POST') {
        const token = await this._getCsrfToken();
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['X-CSRF-Token'] = token;
        return fetch(`/api/sd/${endpoint}`, {
            method,
            headers,
            body: JSON.stringify(body)
        });
    }

    _sdDirectRequest(url, options = {}) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open(options.method || 'GET', url, true);
            if (options.headers) {
                for (const [key, value] of Object.entries(options.headers)) {
                    xhr.setRequestHeader(key, value);
                }
            }
            xhr.responseType = 'text';
            xhr.timeout = 120000;
            xhr.onload = () => {
                resolve({
                    ok: xhr.status >= 200 && xhr.status < 300,
                    status: xhr.status,
                    statusText: xhr.statusText,
                    text: () => Promise.resolve(xhr.responseText),
                    json: () => {
                        try { return Promise.resolve(JSON.parse(xhr.responseText)); }
                        catch (e) { return Promise.reject(e); }
                    }
                });
            };
            xhr.onerror = () => reject(new Error('请求失败: ' + url));
            xhr.ontimeout = () => reject(new Error('请求超时: ' + url));
            xhr.send(options.body || null);
        });
    }

    setApiBaseUrl(url) {
        this._apiBaseUrl = String(url || '').trim();
    }

    async generate(options) {
        const provider = String(options.provider || 'novelai').trim().toLowerCase();
        
        switch (provider) {
            case 'novelai':
                return this._generateNovelAI(options);
            case 'siliconflow':
                return this._generateSiliconFlow(options);
            case 'sd':
                return this._generateStableDiffusion(options, this.getConfig(provider));
            default:
                throw new Error(`未知的生图供应商: ${provider}`);
        }
    }

    getConfig(provider) {
        const storage = window.VirtualPhone?.storage || window.localStorage;
        const getVal = (key, def) => {
            try { 
                const val = storage.get ? storage.get(key) : storage.getItem(key); 
                return (val !== undefined && val !== null && val !== '') ? val : def; 
            } catch(e) { return def; }
        };

        const baseConfig = {
            enabled: getVal('phone-image-enabled', false),
            provider: getVal('phone-image-provider', 'novelai'),
            width: Number(getVal('phone-image-width', 832)) || 832,
            height: Number(getVal('phone-image-height', 1216)) || 1216,
            steps: Number(getVal('phone-image-steps', 28)) || 28,
            scale: Number(getVal('phone-image-scale', 5)),
            seed: Number(getVal('phone-image-seed', -1)),
            cfgRescale: Number(getVal('phone-image-cfg-rescale', 0)),
            fixedPrompt: getVal('phone-image-fixed-prompt', ''),
            fixedPromptEnd: getVal('phone-image-fixed-prompt-end', ''),
            negativePrompt: getVal('phone-image-negative-prompt', '')
        };

        switch (String(provider || '').toLowerCase()) {
            case 'novelai':
                return Object.assign({}, baseConfig, {
                    site: getVal('phone-image-novelai-site', 'https://image.novelai.net'),
                    apiKey: getVal('phone-image-novelai-key', ''),
                    model: getVal('phone-image-novelai-model', 'nai-diffusion-4-curated-preview'),
                    sampler: getVal('phone-image-novelai-sampler', 'k_euler_ancestral'),
                    schedule: getVal('phone-image-novelai-schedule', 'native'),
                    sm: getVal('phone-image-novelai-sm', true),
                    sm_dyn: getVal('phone-image-novelai-sm-dyn', false),
                    decrucp: getVal('phone-image-novelai-decrucp', false),
                    dynamicThresholding: getVal('phone-image-novelai-dynamic-thresholding', false),
                    noise: getVal('phone-image-noise-seed', -1)
                });
            
            case 'siliconflow':
                return Object.assign({}, baseConfig, {
                    apiKey: getVal('phone-image-siliconflow-key', ''),
                    model: getVal('phone-image-siliconflow-model', 'Kwai-Kolors/Kolors')
                });

            case 'sd':
                let sdUrl = getVal('phone-image-sd-url', 'http://127.0.0.1:7860');
                sdUrl = sdUrl.replace(/\/+$/, '');
                if (!/^https?:\/\/.+/i.test(sdUrl)) {
                    sdUrl = 'http://' + sdUrl.replace(/^\/+/, '');
                }
                
                return Object.assign({}, baseConfig, {
                    sdUrl: sdUrl,
                    model: getVal('phone-image-sd-model', ''),
                    sampler: getVal('phone-image-sd-sampler', 'Euler a')
                });
            
            default:
                return baseConfig;
        }
    }

    _joinPrompt(parts) {
        return parts.filter(p => p).map(p => String(p).trim()).filter(p => p).join(', ');
    }

    _waitForImageDecode(dataUrl) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
            img.onerror = () => reject(new Error('图片解码失败'));
            img.src = dataUrl;
            setTimeout(() => reject(new Error('图片加载超时')), 30000);
        });
    }

    async _generateNovelAI(options) {
        const prompt = String(options.prompt || '').trim();
        if (!prompt) throw new Error('缺少生图提示词');

        const config = this.getConfig('novelai');
        const site = String(config.site || '').trim().replace(/\/+$/, '');
        const apiKey = String(config.apiKey || '').trim();

        if (!site) throw new Error('未配置 NovelAI 站点地址');
        if (!apiKey) throw new Error('未配置 NovelAI API Key');

        const width = Number(options.width || config.width);
        const height = Number(options.height || config.height);
        const steps = Number(options.steps || config.steps);
        const scale = Number(options.scale ?? config.scale);
        const seed = Number(options.seed ?? config.seed);
        const cfgRescale = Number(options.cfgRescale ?? config.cfgRescale);

        const positivePrompt = this._joinPrompt([config.fixedPrompt, prompt, config.fixedPromptEnd]);
        const negativePrompt = this._joinPrompt([config.negativePrompt, options.negativePrompt]);

        const payload = {
            input: positivePrompt,
            model: String(config.model || 'nai-diffusion-4-curated-preview'),
            action: 'generate',
            parameters: {
                width,
                height,
                steps,
                scale,
                seed: seed >= 0 ? seed : Math.floor(Math.random() * 2 ** 32),
                n_samples: 1,
                ucPrompts: [negativePrompt],
                sampler: String(config.sampler || 'k_euler_ancestral'),
                schedule: String(config.schedule || 'native'),
                sm: Boolean(config.sm !== undefined ? config.sm : true),
                sm_dyn: Boolean(config.sm_dyn || false),
                dynamic_thresholding: Boolean(config.dynamicThresholding || false)
            }
        };

        if (cfgRescale > 0) {
            payload.parameters.cfg_rescale = cfgRescale;
        }

        const url = `${site}/ai/generate-image`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(payload),
            signal: options.signal
        });

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`生图请求失败 (${response.status})${text ? ': ' + text.slice(0, 200) : ''}`);
        }

        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('image')) {
            const blob = await response.blob();
            const reader = new FileReader();
            await new Promise((resolve, reject) => {
                reader.onload = resolve;
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
            const imageData = reader.result;
            const imageInfo = await this._waitForImageDecode(imageData);

            return {
                provider: 'novelai',
                model: config.model,
                prompt,
                width: imageInfo.width,
                height: imageInfo.height,
                requestedWidth: width,
                requestedHeight: height,
                steps,
                sampler: config.sampler,
                scale,
                seed: payload.parameters.seed,
                imageData,
                imageUrl: imageData
            };
        }

        const result = await response.json().catch(() => null);
        throw new Error(`生图请求失败：未知响应格式`);
    }

    async _generateSiliconFlow(options) {
        const prompt = String(options.prompt || '').trim();
        if (!prompt) throw new Error('缺少生图提示词');

        const config = this.getConfig('siliconflow');
        const apiKey = String(config.apiKey || '').trim();
        if (!apiKey) throw new Error('未配置硅基流动 API Key');

        const model = String(config.model || 'Kwai-Kolors/Kolors');
        const width = Number(options.width || config.width);
        const height = Number(options.height || config.height);
        const steps = Number(options.steps || config.steps);
        const scale = Number(options.scale ?? config.scale);
        const seed = Number(options.seed ?? config.seed);

        const positivePrompt = this._joinPrompt([config.fixedPrompt, prompt, config.fixedPromptEnd]);
        const negativePrompt = this._joinPrompt([config.negativePrompt, options.negativePrompt]);

        const payload = {
            model,
            prompt: positivePrompt,
            image_size: `${width}x${height}`,
            num_inference_steps: steps,
            guidance_scale: scale,
            seed: seed >= 0 ? seed : Math.floor(Math.random() * 2147483647)
        };

        if (negativePrompt) {
            payload.negative_prompt = negativePrompt;
        }

        const response = await fetch('https://api.siliconflow.cn/v1/images/generations', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(payload),
            signal: options.signal
        });

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`硅基流动生图请求失败 (${response.status})${text ? ': ' + text.slice(0, 200) : ''}`);
        }

        const result = await response.json().catch(() => null);
        if (!result?.images?.length) throw new Error('硅基流动未返回图片数据');

        const imageUrl = result.images[0].url;
        if (!imageUrl) throw new Error('硅基流动返回的图片 URL 为空');

        const imageResponse = await fetch(imageUrl, { signal: options.signal });
        if (!imageResponse.ok) throw new Error(`下载图片失败 (${imageResponse.status})`);

        const blob = await imageResponse.blob();
        const reader = new FileReader();
        await new Promise((resolve, reject) => {
            reader.onload = resolve;
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });

        const imageData = reader.result;
        const imageInfo = await this._waitForImageDecode(imageData);

        return {
            provider: 'siliconflow',
            model,
            prompt,
            width: imageInfo.width,
            height: imageInfo.height,
            requestedWidth: width,
            requestedHeight: height,
            steps,
            scale,
            seed: payload.seed,
            imageData,
            imageUrl: imageData
        };
    }

    async fetchSdModels(baseUrl) {
        const now = Date.now();
        if (this._sdModelsCache && now - this._sdModelsCacheTime < this._sdModelsCacheTtl) {
            return this._sdModelsCache;
        }

        baseUrl = String(baseUrl || '').trim();
        baseUrl = baseUrl.replace(/\/+$/, '');
        if (!/^https?:\/\/.+/i.test(baseUrl)) {
            baseUrl = 'http://' + baseUrl.replace(/^\/+/, '');
        }

        if (this._isSillyTavern()) {
            console.log('[SD] 检测到 SillyTavern 环境，使用代理端点');
            try {
                const response = await this._sdProxyRequest('models', { url: baseUrl });
                if (response.ok) {
                    const data = await response.json();
                    let models = Array.isArray(data) ? data : [];
                    if (models.length > 0) {
                        if (models[0].value !== undefined && models[0].text !== undefined) {
                            models = models.map(m => ({
                                title: String(m.value || m.text || ''),
                                model_name: String(m.text || m.value || '').replace(/\.[^.]+$/, ''),
                                hash: String(m.value || ''),
                                config: null
                            }));
                        }
                        this._sdModelsCache = models;
                        this._sdModelsCacheTime = now;
                        console.log('[SD] 通过代理获取到模型:', models.length);
                        return models;
                    }
                }
                console.warn('[SD] 代理端点返回异常，尝试直接连接');
            } catch (e) {
                console.warn('[SD] 代理端点失败:', e.message, '，尝试直接连接');
            }
        }

        const endpoints = [
            '/sdapi/v1/sd-models',
            '/api/sd-models'
        ];

        let lastError = null;
        for (const endpoint of endpoints) {
            const url = `${baseUrl}${endpoint}`;
            console.log('[SD] 尝试直接连接:', url);
            
            try {
                const response = await this._sdDirectRequest(url, { 
                    method: 'GET',
                    headers: { 'Accept': 'application/json' }
                });
                
                if (!response.ok) {
                    lastError = `HTTP ${response.status}: ${endpoint}`;
                    continue;
                }
                
                const models = await response.json();
                
                if (Array.isArray(models)) {
                    this._sdModelsCache = models;
                    this._sdModelsCacheTime = now;
                    return models;
                }
                lastError = `端点 ${endpoint} 返回非数组格式`;
            } catch (err) {
                lastError = `端点 ${endpoint} 错误: ${err.message}`;
            }
        }

        throw new Error(`SD模型列表获取失败\n\n最后错误: ${lastError}\n\n排查步骤：\n1. 请确认 SD WebUI 已启动并添加 --api 参数\n2. 如在 SillyTavern 中，请在酒馆扩展设置中配置 SD 连接\n3. 直接访问测试: ${baseUrl}/sdapi/v1/sd-models`);
    }

    buildSdModelHashMap(models) {
        const map = new Map();
        for (const model of models) {
            const name = String(model?.model_name || model?.name || '').trim();
            const hash = String(model?.hash || '').trim();
            if (name && hash) {
                map.set(name.toLowerCase(), hash);
                map.set(name, hash);
            }
        }
        return map;
    }

    async getSdModelHash(baseUrl, modelName) {
        const models = await this.fetchSdModels(baseUrl);
        const map = this.buildSdModelHashMap(models);
        return map.get(String(modelName || '').trim()) || map.get(String(modelName || '').trim().toLowerCase()) || null;
    }

    async _generateStableDiffusion(options, config) {
        const prompt = String(options.prompt || '').trim();
        if (!prompt) throw new Error('缺少生图提示词');

        let baseUrl = String(config.sdUrl || '').trim();
        baseUrl = baseUrl.replace(/\/+$/, '');
        if (!baseUrl) throw new Error('未配置 Stable Diffusion 服务地址');
        if (!/^https?:\/\/.+/i.test(baseUrl)) {
            baseUrl = 'http://' + baseUrl.replace(/^\/+/, '');
        }

        const modelName = String(config.model || '').trim();
        const modelHash = await this.getSdModelHash(baseUrl, modelName).catch(() => null);

        const width = Number(options.width || config.width);
        const height = Number(options.height || config.height);
        const steps = Number(options.steps || config.steps);
        const scale = Number(options.scale ?? config.scale);
        const seed = Number(options.seed ?? config.seed);
        const cfgRescale = Number(options.cfgRescale ?? config.cfgRescale);

        const positivePrompt = this._joinPrompt([config.fixedPrompt, prompt, config.fixedPromptEnd]);
        const negativePrompt = this._joinPrompt([config.negativePrompt, options.negativePrompt]);

        const payload = {
            prompt: positivePrompt,
            negative_prompt: negativePrompt,
            width,
            height,
            steps,
            cfg_scale: scale,
            seed: seed >= 0 ? seed : -1,
            sampler_name: config.sampler || 'Euler a',
            batch_size: 1,
            n_iter: 1
        };

        if (modelName) {
            payload.override_settings = { sd_model_checkpoint: modelName };
        }
        if (cfgRescale > 0) {
            payload.cfg_rescale = cfgRescale;
        }

        let result = null;

        if (this._isSillyTavern()) {
            console.log('[SD] 通过 SillyTavern 代理生图');
            try {
                payload.url = baseUrl;
                const response = await this._sdProxyRequest('generate', payload);
                if (response.ok) {
                    result = await response.json();
                    if (result && (result.images || result.image)) {
                        console.log('[SD] 代理生图成功');
                    } else {
                        result = null;
                    }
                } else {
                    const errText = await response.text().catch(() => '');
                    console.warn('[SD] 代理生图失败:', response.status, errText);
                }
            } catch (e) {
                console.warn('[SD] 代理生图异常:', e.message, '，尝试直接连接');
            }
            delete payload.url;
        }

        if (!result) {
            const txt2imgEndpoints = [
                '/sdapi/v1/txt2img',
                '/api/txt2img'
            ];

            let lastError = null;
            let response = null;

            for (const endpoint of txt2imgEndpoints) {
                const url = `${baseUrl}${endpoint}`;
                try {
                    response = await this._sdDirectRequest(url, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Accept': 'application/json'
                        },
                        body: JSON.stringify(payload)
                    });
                    
                    const text = await response.text();
                    result = null;
                    try { result = text ? JSON.parse(text) : null; } catch (e) { result = null; }

                    if (response.ok && result && (result.images || result.image)) {
                        break;
                    }
                    lastError = `HTTP ${response.status}: ${endpoint}`;
                } catch (err) {
                    lastError = `端点 ${endpoint} 错误: ${err.message}`;
                }
            }

            if (!response || !response.ok || !result) {
                const msg = result?.error?.message || result?.message || '';
                const endpointInfo = lastError ? `\n错误: ${lastError}` : '';
                throw new Error(`Stable Diffusion 请求失败${msg ? `: ${String(msg).slice(0, 180)}` : ''}${endpointInfo}`);
            }
        }

        const imageData = this._extractSdImage(result);
        if (!imageData) throw new Error('Stable Diffusion 未返回可用图片');

        const imageInfo = await this._waitForImageDecode(imageData).catch((err) => {
            throw new Error(`SD 返回图片不可用: ${err?.message || err}`);
        });

        return {
            provider: 'sd',
            model: modelName,
            modelHash,
            prompt,
            width: imageInfo.width,
            height: imageInfo.height,
            requestedWidth: width,
            requestedHeight: height,
            steps,
            sampler: config.sampler || 'Euler a',
            scale,
            seed: payload.seed,
            imageData,
            imageUrl: imageData
        };
    }

    _extractSdImage(payload) {
        const images = Array.isArray(payload?.images) ? payload.images : [];
        for (const img of images) {
            if (typeof img === 'string') {
                if (img.startsWith('data:image/')) return img;
                if (/^[A-Za-z0-9+/=\s]+$/.test(img.slice(0, 120))) {
                    return `data:image/png;base64,${img.replace(/\s+/g, '')}`;
                }
            }
        }
        if (typeof payload?.image === 'string') {
            if (payload.image.startsWith('data:image/')) return payload.image;
            if (/^[A-Za-z0-9+/=\s]+$/.test(payload.image.slice(0, 120))) {
                return `data:image/png;base64,${payload.image.replace(/\s+/g, '')}`;
            }
        }
        return '';
    }
}