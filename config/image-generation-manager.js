/* ========================================================
 *  柚月小手机 (Yuzuki's Little Phone)
 *  作者 (Author): yuzuki
 *
 * ⚠️ 版权声明 (Copyright Notice):
 * 1. 禁止商业化：本项目仅供交流学习，严禁任何形式的倒卖、盈利等商业行为。
 * 2. 禁止二改发布：严禁未经授权修改代码后作为独立项目二次发布或分发。
 * 3. 禁止抄袭：严禁盗用本项目的核心逻辑、UI设计与相关原代码。
 *
 * Copyright (c) yuzuki. All rights reserved.
 * ======================================================== */

export class ImageGenerationManager {
    constructor(storage) {
        this.storage = storage;
        this._queueUserId = null;
        this._lastQueueNotice = '';
    }

    _get(key, fallback = '') {
        const value = this.storage?.get?.(key);
        if (value === null || value === undefined || value === '') return fallback;
        return value;
    }

    _getBool(key, fallback = false) {
        const value = this.storage?.get?.(key);
        if (value === null || value === undefined || value === '') return fallback;
        return value === true || value === 'true';
    }

    _getNumber(key, fallback, min = null, max = null) {
        const raw = this.storage?.get?.(key);
        if (raw === null || raw === undefined || raw === '') return fallback;
        const value = Number(raw);
        let result = Number.isFinite(value) ? value : fallback;
        if (min !== null) result = Math.max(min, result);
        if (max !== null) result = Math.min(max, result);
        return result;
    }

    _normalizeNovelAISampler(value) {
        const sampler = String(value || '').trim();
        const allowed = new Set([
            'k_euler',
            'ddim_v3',
            'k_dpmpp_2s_ancestral',
            'k_dpmpp_2m',
            'k_euler_ancestral',
            'k_dpmpp_2m_sde',
            'k_dpmpp_sde'
        ]);
        return allowed.has(sampler) ? sampler : 'k_euler';
    }

    _normalizeNovelAISchedule(value) {
        const schedule = String(value || '').trim();
        const allowed = new Set(['native', 'exponential', 'polyexponential', 'karras']);
        return allowed.has(schedule) ? schedule : 'native';
    }

    _isNovelAIV4Model(model) {
        return /^nai-diffusion-4(?:-|$)/i.test(String(model || '').trim());
    }

    _clampReferenceValue(value, fallback = 0.7, min = 0, max = 1) {
        const num = Number.parseFloat(value);
        if (!Number.isFinite(num)) return fallback;
        const clamped = Math.max(min, Math.min(max, num));
        return Math.round(clamped * 100) / 100;
    }

    _normalizeNovelAIReferenceImage(value) {
        const raw = String(value || '').trim();
        if (!raw) return '';
        const dataUrlMatch = raw.match(/^data:image\/[a-z0-9.+-]+;base64,([\s\S]+)$/i);
        if (dataUrlMatch) return dataUrlMatch[1].replace(/\s+/g, '');
        if (/^[A-Za-z0-9+/=\s]+$/.test(raw.slice(0, 120))) return raw.replace(/\s+/g, '');
        return '';
    }

    _buildNovelAIReferenceCacheKey(imageBase64 = '') {
        const text = String(imageBase64 || '');
        let hash = 2166136261;
        for (let i = 0; i < text.length; i++) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return `phone-ref-${(hash >>> 0).toString(16)}-${text.length}`;
    }

    _normalizeNovelAIReferences(options = {}) {
        const rawList = Array.isArray(options.novelAIReferences)
            ? options.novelAIReferences
            : (Array.isArray(options.referenceImages) ? options.referenceImages : []);
        return rawList
            .map((item) => {
                const image = typeof item === 'string'
                    ? this._normalizeNovelAIReferenceImage(item)
                    : this._normalizeNovelAIReferenceImage(item?.image || item?.imageData || item?.dataUrl || item?.base64);
                if (!image) return null;
                return {
                    image,
                    cacheSecretKey: String(item?.cacheSecretKey || item?.cache_secret_key || '').trim()
                        || this._buildNovelAIReferenceCacheKey(image),
                    strength: this._clampReferenceValue(item?.strength ?? item?.referenceStrength, 0.7, 0, 1),
                    informationExtracted: this._clampReferenceValue(
                        item?.informationExtracted ?? item?.referenceInformationExtracted,
                        1,
                        0,
                        1
                    )
                };
            })
            .filter(Boolean)
            .slice(0, 4);
    }

    _containsCjk(text) {
        return /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/.test(String(text || ''));
    }

    _cleanNovelAITagText(text) {
        return String(text || '')
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[a-z]*|```/gi, ''))
            .replace(/^\s*(?:prompt|positive prompt|tags?|nai tags?|english tags?|提示词|正面提示词)\s*[:：]/i, '')
            .replace(/[\r\n;；]+/g, ', ')
            .replace(/[，、]/g, ', ')
            .replace(/[。！？]/g, '')
            .replace(/\s*,\s*/g, ', ')
            .replace(/\s{2,}/g, ' ')
            .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '')
            .trim();
    }

    async _translatePromptForNovelAI(rawPrompt, appKey = '') {
        const source = String(rawPrompt || '').trim();
        if (!source || !this._containsCjk(source)) return source;

        const apiManager = (typeof window !== 'undefined') ? window.VirtualPhone?.apiManager : null;
        if (!apiManager || typeof apiManager.callAI !== 'function') {
            return source;
        }

        const appName = ['wechat', 'weibo'].includes(appKey) ? appKey : 'phone_online';
        const messages = [
            {
                role: 'system',
                content: [
                    'You convert Chinese image descriptions into NovelAI positive prompt tags.',
                    'Output only English comma-separated tags.',
                    'Do not add explanations, Markdown, Chinese, or full sentences.',
                    'Preserve visible subject, gender, count, pose, expression, clothing, setting, camera distance, angle, atmosphere, and anime illustration style.',
                    'If the source implies people or humanoids, include clear tags such as 1girl, 1boy, adult character, male focus, or female focus when appropriate.',
                    'Do not add unrelated quality tags unless they are clearly requested by the source.'
                ].join('\n')
            },
            {
                role: 'user',
                content: `Chinese source description:\n${source}\n\nEnglish NovelAI tags only:`
            }
        ];

        try {
            const result = await apiManager.callAI(messages, {
                appId: appName,
                max_tokens: 360,
                stream: false
            });
            const translated = this._cleanNovelAITagText(result?.summary || result?.content || result?.text || '');
            if (translated && !this._containsCjk(translated)) {
                return translated;
            }
        } catch (e) {
            console.warn('[NovelAI] 中文提示词自动转英文失败，已回退原描述:', e);
        }
        return source;
    }

    async _prepareNovelAIOptions(options = {}) {
        const appKey = String(options?.app || '').trim().toLowerCase();
        if (!['wechat', 'weibo'].includes(appKey)) return options;

        const rawPrompt = String(options.prompt || '').trim();
        if (!this._containsCjk(rawPrompt)) return options;

        const translatedPrompt = await this._translatePromptForNovelAI(rawPrompt, appKey);
        if (!translatedPrompt || translatedPrompt === rawPrompt) return options;

        return {
            ...options,
            rawPrompt,
            prompt: translatedPrompt,
            translatedPrompt
        };
    }

    _getAppDefaultSize(app) {
        switch (String(app || '').trim().toLowerCase()) {
            case 'honey':
                return { width: 832, height: 1216 };
            case 'wechat':
                return { width: 512, height: 512 };
            case 'weibo':
                return { width: 1024, height: 1024 };
            default:
                return { width: 832, height: 1216 };
        }
    }

    getSizeForApp(app = '') {
        const appKey = String(app || '').trim().toLowerCase();
        const defaults = this._getAppDefaultSize(appKey);
        if (!appKey) {
            return {
                width: this._getNumber('phone-image-width', defaults.width, 64, 2048),
                height: this._getNumber('phone-image-height', defaults.height, 64, 2048)
            };
        }

        return {
            width: this._getNumber(`phone-image-${appKey}-width`, defaults.width, 64, 2048),
            height: this._getNumber(`phone-image-${appKey}-height`, defaults.height, 64, 2048)
        };
    }

    getConfig(overrides = {}) {
        const provider = String(overrides.provider || this._get('phone-image-provider', 'novelai')).trim() || 'novelai';
        const appKey = String(overrides.app || '').trim().toLowerCase();
        const legacySiliconflowKey = String(this._get('siliconflow_api_key', '') || '').trim();
        const legacySiliconflowModel = String(this._get('image_generation_model', '') || '').trim();
        const appDefaults = this._getAppDefaultSize(appKey);
        const rawSize = this.getSizeForApp(appKey);
        const size = { ...rawSize };
        const rawSteps = this._getNumber('phone-image-steps', 28, 1, 50);
        const promptAppKey = ['honey', 'wechat', 'weibo'].includes(appKey) ? appKey : '';

        if (appKey === 'honey') {
            if (size.width < 512 || size.height < 768) {
                size.width = appDefaults.width;
                size.height = appDefaults.height;
            }
        }
        const steps = appKey === 'honey' && provider === 'novelai' && rawSteps < 20
            ? 28
            : rawSteps;

        let sampler;
        let schedule;
        if (provider === 'sd') {
            sampler = String(overrides.sampler || this._get('phone-image-sd-sampler', 'Euler a')).trim() || 'Euler a';
            schedule = '';
        } else {
            sampler = this._normalizeNovelAISampler(overrides.sampler || this._get('phone-image-novelai-sampler', 'k_euler'));
            schedule = this._normalizeNovelAISchedule(overrides.schedule || this._get('phone-image-novelai-schedule', 'native'));
        }

        let model;
        if (provider === 'sd') {
            model = String(overrides.model || this._get('phone-image-sd-model', '')).trim();
        } else {
            model = String(overrides.model || this._get(`phone-image-${provider}-model`, '') || (provider === 'novelai' ? 'nai-diffusion-4-5-full' : legacySiliconflowModel || 'Kwai-Kolors/Kolors')).trim();
        }

        return {
            enabled: overrides.enabled ?? this._getBool('phone-image-enabled', false),
            provider,
            apiKey: String(overrides.apiKey || this._get(`phone-image-${provider}-key`, '') || (provider === 'siliconflow' ? legacySiliconflowKey : '')).trim(),
            site: String(overrides.site || this._get('phone-image-novelai-site', 'official')).trim() || 'official',
            customUrl: String(overrides.customUrl || this._get('phone-image-novelai-url', '')).trim(),
            queueUrl: String(overrides.queueUrl || this._get('phone-image-novelai-queue-url', '')).trim(),
            sdUrl: String(overrides.sdUrl || this._get('phone-image-sd-url', 'http://localhost:7860')).trim(),
            model,
            sampler,
            schedule,
            width: size.width,
            height: size.height,
            steps,
            scale: this._getNumber('phone-image-scale', appKey === 'honey' ? 7 : 5, 0, 50),
            cfgRescale: this._getNumber('phone-image-cfg-rescale', 0, 0, 1),
            seed: this._getNumber('phone-image-seed', -1, -1, 4294967295),
            fixedPrompt: String(overrides.fixedPrompt ?? (promptAppKey ? this._get(`phone-image-${promptAppKey}-fixed-prompt`, '') : '')).trim(),
            fixedPromptEnd: String(overrides.fixedPromptEnd ?? (promptAppKey ? this._get(`phone-image-${promptAppKey}-fixed-prompt-end`, '') : '')).trim(),
            negativePrompt: String(overrides.negativePrompt ?? (promptAppKey ? this._get(`phone-image-${promptAppKey}-negative-prompt`, '') : '')).trim(),
            debugPayload: this._getBool('phone-image-debug-payload', false),
            saveToBackgrounds: this._getBool('phone-image-save-backgrounds', false)
        };
    }

    async generate(options = {}) {
        const config = this.getConfig(options);
        if (!config.enabled && options.ignoreEnabled !== true) throw new Error('生图功能未启用');

        if (config.provider === 'siliconflow') {
            if (!config.apiKey) throw new Error('缺少生图 API Key');
            return this._generateSiliconflow(options, config);
        }
        if (config.provider === 'novelai') {
            if (!config.apiKey) throw new Error('缺少生图 API Key');
            const novelAIOptions = await this._prepareNovelAIOptions(options);
            return this._generateNovelAI(novelAIOptions, config);
        }
        if (config.provider === 'sd') {
            return this._generateStableDiffusion(options, config);
        }
        throw new Error(`暂不支持的生图服务商：${config.provider}`);
    }

    _joinPrompt(parts = [], separator = ', ') {
        return parts
            .map(item => String(item || '').trim())
            .filter(Boolean)
            .join(separator);
    }

    _debugNovelAIRequest({ endpoint, payload, config, options }) {
        if (!config?.debugPayload) return;
        const originalPrompt = String(options?.rawPrompt || options?.prompt || '').trim();
        const translatedPrompt = String(options?.translatedPrompt || '').trim();
        const debugPayload = this._redactNovelAIDebugPayload(payload);
        const debugInfo = {
            endpoint,
            provider: 'novelai',
            app: String(options?.app || '').trim(),
            model: config.model,
            sampler: config.sampler,
            schedule: config.schedule,
            width: payload?.parameters?.width,
            height: payload?.parameters?.height,
            steps: payload?.parameters?.steps,
            scale: payload?.parameters?.scale,
            cfgRescale: payload?.parameters?.cfg_rescale,
            seed: payload?.parameters?.seed,
            originalPrompt,
            translatedPrompt,
            positivePrompt: payload?.input || '',
            negativePrompt: payload?.parameters?.negative_prompt || '',
            referenceCount: Array.isArray(payload?.parameters?.reference_image_multiple_cached)
                ? payload.parameters.reference_image_multiple_cached.length
                : (Array.isArray(payload?.parameters?.director_reference_images_cached)
                    ? payload.parameters.director_reference_images_cached.length
                    : (Array.isArray(payload?.parameters?.director_reference_images)
                        ? payload.parameters.director_reference_images.length
                        : (Array.isArray(payload?.parameters?.reference_image_multiple)
                            ? payload.parameters.reference_image_multiple.length
                            : 0))),
            payload: debugPayload
        };
        try {
            if (typeof window !== 'undefined') {
                window.__lastNovelAIRequest = debugInfo;
            }
        } catch (e) {}
        try {
            const plainText = [
                '[NovelAI Debug] 本次生图参数',
                `App: ${debugInfo.app || '-'}`,
                `模型: ${debugInfo.model}`,
                `尺寸: ${debugInfo.width}x${debugInfo.height}`,
                `Steps: ${debugInfo.steps}`,
                `Sampler: ${debugInfo.sampler}`,
                `Schedule: ${debugInfo.schedule}`,
                `Scale: ${debugInfo.scale}`,
                `CFG Rescale: ${debugInfo.cfgRescale}`,
                `Seed: ${debugInfo.seed}`,
                `参考图: ${debugInfo.referenceCount} 张`,
                '',
                'AI 画面 tag（原样）:',
                debugInfo.originalPrompt || '(空)',
                ...(debugInfo.translatedPrompt ? [
                    '',
                    '自动转英文后的 NAI tag:',
                    debugInfo.translatedPrompt
                ] : []),
                '',
                '最终发送给 NAI 的正面提示词:',
                debugInfo.positivePrompt || '(空)',
                '',
                '最终发送给 NAI 的负面提示词:',
                debugInfo.negativePrompt || '(空)',
                '',
                '调试 payload 已保存到 window.__lastNovelAIRequest（参考图 base64 已脱敏）',
                '复制完整调试信息: copy(JSON.stringify(window.__lastNovelAIRequest, null, 2))'
            ].join('\n');
            console.log(plainText);
            console.groupCollapsed('[NovelAI Debug] generate-image payload');
            console.info('summary', {
                endpoint: debugInfo.endpoint,
                app: debugInfo.app,
                model: debugInfo.model,
                size: `${debugInfo.width}x${debugInfo.height}`,
                steps: debugInfo.steps,
                sampler: debugInfo.sampler,
                schedule: debugInfo.schedule,
                scale: debugInfo.scale,
                cfgRescale: debugInfo.cfgRescale,
                seed: debugInfo.seed,
                referenceCount: debugInfo.referenceCount
            });
            console.info('AI 画面 tag（原样）', debugInfo.originalPrompt);
            if (debugInfo.translatedPrompt) console.info('自动转英文后的 NAI tag', debugInfo.translatedPrompt);
            console.info('positive prompt', debugInfo.positivePrompt);
            console.info('negative prompt', debugInfo.negativePrompt);
            console.info('full payload', debugInfo.payload);
            console.info('copy helper', 'copy(JSON.stringify(window.__lastNovelAIRequest, null, 2))');
            console.groupEnd();
        } catch (e) {}
    }

    _redactNovelAIDebugPayload(payload) {
        try {
            const clone = JSON.parse(JSON.stringify(payload || {}));
            const refs = clone?.parameters?.reference_image_multiple;
            if (Array.isArray(refs)) {
                clone.parameters.reference_image_multiple = refs.map((item, index) => {
                    const length = String(item || '').length;
                    return `[BASE64_REFERENCE_IMAGE_${index + 1}:${length}]`;
                });
            }
            const cachedRefs = clone?.parameters?.reference_image_multiple_cached;
            if (Array.isArray(cachedRefs)) {
                clone.parameters.reference_image_multiple_cached = cachedRefs.map((item, index) => ({
                    cache_secret_key: String(item?.cache_secret_key || ''),
                    data: `[BASE64_REFERENCE_IMAGE_CACHED_${index + 1}:${String(item?.data || '').length}]`
                }));
            }
            const directorRefs = clone?.parameters?.director_reference_images;
            if (Array.isArray(directorRefs)) {
                clone.parameters.director_reference_images = directorRefs.map((item, index) => {
                    const length = String(item || '').length;
                    return `[BASE64_DIRECTOR_REFERENCE_IMAGE_${index + 1}:${length}]`;
                });
            }
            const cachedDirectorRefs = clone?.parameters?.director_reference_images_cached;
            if (Array.isArray(cachedDirectorRefs)) {
                clone.parameters.director_reference_images_cached = cachedDirectorRefs.map((item, index) => ({
                    cache_secret_key: String(item?.cache_secret_key || ''),
                    data: `[BASE64_DIRECTOR_REFERENCE_IMAGE_CACHED_${index + 1}:${String(item?.data || '').length}]`
                }));
            }
            return clone;
        } catch (e) {
            return payload;
        }
    }

    _resolveNovelAIEndpoint(config) {
        if (config.site === 'custom' && config.customUrl) {
            return config.customUrl.replace(/\/+$/, '');
        }
        return 'https://image.novelai.net';
    }

    _resolveNovelAIQueueUrl(config) {
        return String(config?.queueUrl || '').trim().replace(/\/+$/, '');
    }

    _createQueueTaskId() {
        return `phone-nai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }

    _getQueueUserId() {
        if (this._queueUserId) return this._queueUserId;
        const storageKey = 'phone_nai_queue_user_id';
        try {
            const stored = window.localStorage?.getItem(storageKey);
            if (stored) {
                this._queueUserId = stored;
                return stored;
            }
            const cryptoApi = globalThis.crypto;
            const randomPart = typeof cryptoApi?.randomUUID === 'function'
                ? cryptoApi.randomUUID()
                : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
            const userId = `phone-${randomPart}`;
            window.localStorage?.setItem(storageKey, userId);
            this._queueUserId = userId;
            return userId;
        } catch (e) {
            this._queueUserId = `phone-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
            return this._queueUserId;
        }
    }

    async _hashQueueKey(apiKey) {
        const text = String(apiKey || '');
        if (!text) throw new Error('缺少 NAI API Key，无法进入共享队列');
        try {
            const cryptoApi = globalThis.crypto;
            if (typeof cryptoApi?.subtle?.digest === 'function' && typeof TextEncoder === 'function') {
                const buffer = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(text));
                return Array.from(new Uint8Array(buffer)).map(byte => byte.toString(16).padStart(2, '0')).join('');
            }
        } catch (e) {}

        let hash = 0;
        for (let i = 0; i < text.length; i++) {
            hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
        }
        return `fallback-${Math.abs(hash).toString(16)}`;
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    _getQueueToken(payload) {
        return String(payload?.token || payload?.queue_token || payload?.queueToken || '').trim();
    }

    _getQueuePosition(payload) {
        const raw = payload?.position ?? payload?.queue_position ?? payload?.rank;
        const value = Number(raw);
        return Number.isFinite(value) ? value : null;
    }

    _getQueueSize(payload) {
        const raw = payload?.queue_size ?? payload?.queueSize ?? payload?.size;
        const value = Number(raw);
        return Number.isFinite(value) ? value : null;
    }

    _formatQueueStatus(payload) {
        const position = this._getQueuePosition(payload);
        const size = this._getQueueSize(payload);
        if (position === null) return '';
        const displayPosition = Math.max(1, position + 1);
        if (size !== null && size > 0) return `NAI 队列排队中：第 ${displayPosition}/${size} 位`;
        return `NAI 队列排队中：第 ${displayPosition} 位`;
    }

    _noticeQueueStatus(payload, force = false) {
        const text = this._formatQueueStatus(payload);
        if (!text || (!force && text === this._lastQueueNotice)) return;
        this._lastQueueNotice = text;
        console.log(`[NovelAI Queue] ${text}`);
        try {
            window.VirtualPhone?.phoneShell?.showNotification?.('NAI 共享队列', text, '🎨');
        } catch (e) {}
    }

    async _queueRequest(baseUrl, path, { method = 'GET', body = null, query = null } = {}) {
        const url = new URL(`${baseUrl}${path}`);
        if (query && typeof query === 'object') {
            Object.entries(query).forEach(([key, value]) => {
                if (value !== null && value !== undefined && value !== '') {
                    url.searchParams.set(key, String(value));
                }
            });
        }

        const response = await fetch(url.toString(), {
            method,
            headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
            body: method === 'POST' ? JSON.stringify(body || {}) : undefined
        });
        const text = await response.text().catch(() => '');
        let payload = null;
        try { payload = text ? JSON.parse(text) : null; } catch (e) { payload = null; }
        if (!response.ok) {
            const message = payload?.message || payload?.error || text || '';
            throw new Error(`NAI 队列服务请求失败 (${response.status})${message ? `: ${String(message).slice(0, 180)}` : ''}`);
        }
        return payload || {};
    }

    async _waitForNovelAIQueueTurn(config, options = {}) {
        const baseUrl = this._resolveNovelAIQueueUrl(config);
        if (!baseUrl) return null;

        const keyHash = await this._hashQueueKey(config.apiKey);
        const userId = this._getQueueUserId();
        const taskId = String(options.queueTaskId || this._createQueueTaskId()).trim();
        const queuePayload = { key_hash: keyHash, user_id: userId, task_id: taskId };
        let token = '';
        let joined = false;
        let leftQueue = false;

        const leave = async () => {
            if (!joined || leftQueue) return;
            leftQueue = true;
            await this._queueRequest(baseUrl, '/leave-queue', {
                method: 'POST',
                body: { ...queuePayload, token }
            }).catch((err) => console.warn('[NovelAI Queue] 离开队列失败:', err));
        };

        try {
            const joinedInfo = await this._queueRequest(baseUrl, '/queue', {
                method: 'POST',
                body: queuePayload
            });
            joined = true;
            token = this._getQueueToken(joinedInfo);
            this._noticeQueueStatus(joinedInfo, true);
            if (joinedInfo?.can_run && token) {
                return { baseUrl, keyHash, userId, taskId, token };
            }

            for (let retry = 0; retry < 120; retry++) {
                if (options?.signal?.aborted) {
                    await leave();
                    throw new Error('已取消 NAI 生图队列等待');
                }
                await this._sleep(3000);
                const turnInfo = await this._queueRequest(baseUrl, '/my-turn', {
                    query: queuePayload
                });
                token = this._getQueueToken(turnInfo) || token;
                this._noticeQueueStatus(turnInfo);
                if (turnInfo?.can_run && token) {
                    return { baseUrl, keyHash, userId, taskId, token };
                }
            }

            await leave();
            throw new Error('等待 NAI 共享队列超时，请稍后重试');
        } catch (err) {
            if (!String(err?.message || '').includes('已取消 NAI 生图队列等待')) {
                await leave();
            }
            throw err;
        }
    }

    async _finishNovelAIQueue(queueInfo) {
        if (!queueInfo?.baseUrl || !queueInfo?.token) return;
        await this._queueRequest(queueInfo.baseUrl, '/complete', {
            method: 'POST',
            body: {
                key_hash: queueInfo.keyHash,
                user_id: queueInfo.userId,
                task_id: queueInfo.taskId,
                token: queueInfo.token
            }
        }).catch((err) => console.warn('[NovelAI Queue] 完成队列任务失败:', err));
    }

    _extractBase64Image(payload) {
        const candidates = [
            payload?.image,
            payload?.imageData,
            payload?.data,
            payload?.output,
            payload?.images?.[0],
            payload?.result?.image,
            payload?.result?.images?.[0]
        ];
        for (const item of candidates) {
            if (!item) continue;
            if (typeof item === 'string') {
                if (item.startsWith('data:image/')) return item;
                if (/^[A-Za-z0-9+/=\s]+$/.test(item.slice(0, 120))) return `data:image/png;base64,${item.replace(/\s+/g, '')}`;
            }
            if (typeof item === 'object') {
                const nested = this._extractBase64Image(item);
                if (nested) return nested;
            }
        }
        return '';
    }

    async _readZipImage(response) {
        const blob = await response.blob();
        if (!blob || blob.size <= 0) throw new Error('NovelAI 返回空图片数据');
        const arrayBuffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
        if (!isZip) {
            const mime = blob.type && blob.type.startsWith('image/') ? blob.type : 'image/png';
            return await this._blobToDataUrl(new Blob([blob], { type: mime }));
        }

        if (window.JSZip) {
            const zip = await window.JSZip.loadAsync(arrayBuffer);
            const imageFile = Object.values(zip.files)
                .filter(file => !file.dir && /\.(png|jpg|jpeg|webp)$/i.test(file.name))
                .sort((a, b) => {
                    const sizeA = Number(a?._data?.uncompressedSize || a?._data?.compressedSize || 0);
                    const sizeB = Number(b?._data?.uncompressedSize || b?._data?.compressedSize || 0);
                    return sizeB - sizeA;
                })[0];
            if (!imageFile) throw new Error('NovelAI ZIP 中未找到图片文件');
            const imageBlob = await imageFile.async('blob');
            return await this._blobToDataUrl(imageBlob);
        }

        const imageBlob = await this._readZipImageNative(bytes, arrayBuffer);
        return await this._blobToDataUrl(imageBlob);
    }

    _blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(reader.error || new Error('图片读取失败'));
            reader.readAsDataURL(blob);
        });
    }

    _waitForImageDecode(src, timeoutMs = 12000) {
        return new Promise((resolve, reject) => {
            if (!src) {
                reject(new Error('图片数据为空'));
                return;
            }
            const image = new Image();
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                reject(new Error('图片解码超时'));
            }, timeoutMs);
            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve({ width: image.naturalWidth || 0, height: image.naturalHeight || 0 });
            };
            image.onload = finish;
            image.onerror = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(new Error('图片解码失败'));
            };
            image.src = src;
            if (typeof image.decode === 'function') {
                image.decode().then(finish).catch(() => {
                    if (image.complete && image.naturalWidth > 0) finish();
                });
            }
        });
    }

    async _readZipImageNative(bytes, arrayBuffer) {
        const entry = this._findZipImageEntry(bytes, arrayBuffer);
        if (!entry) throw new Error('NovelAI ZIP 中未找到图片文件');

        const compressed = bytes.slice(entry.dataStart, entry.dataStart + entry.compressedSize);
        let fileBytes = compressed;
        if (entry.method === 8) {
            fileBytes = await this._inflateRawDeflate(compressed);
        } else if (entry.method !== 0) {
            throw new Error(`当前环境不支持 ZIP 压缩方式：${entry.method}`);
        }

        const lowerName = String(entry.name || '').toLowerCase();
        const mime = lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')
            ? 'image/jpeg'
            : (lowerName.endsWith('.webp') ? 'image/webp' : 'image/png');
        return new Blob([fileBytes], { type: mime });
    }

    _findZipImageEntry(bytes, arrayBuffer) {
        const view = new DataView(arrayBuffer);
        const decoder = new TextDecoder('utf-8');
        const imageExtPattern = /\.(png|jpg|jpeg|webp)$/i;
        let bestEntry = null;

        for (let offset = 0; offset <= bytes.length - 46; offset++) {
            if (view.getUint32(offset, true) !== 0x02014b50) continue;
            const method = view.getUint16(offset + 10, true);
            const compressedSize = view.getUint32(offset + 20, true);
            const fileNameLength = view.getUint16(offset + 28, true);
            const extraLength = view.getUint16(offset + 30, true);
            const commentLength = view.getUint16(offset + 32, true);
            const localHeaderOffset = view.getUint32(offset + 42, true);
            const nameStart = offset + 46;
            const nameEnd = nameStart + fileNameLength;
            if (nameEnd > bytes.length) break;

            const name = decoder.decode(bytes.slice(nameStart, nameEnd));
            const nextOffset = nameEnd + extraLength + commentLength;
            if (!imageExtPattern.test(name) || compressedSize <= 0) {
                offset = Math.max(offset, nextOffset - 1);
                continue;
            }

            if (localHeaderOffset < 0 || localHeaderOffset + 30 > bytes.length) continue;
            if (view.getUint32(localHeaderOffset, true) !== 0x04034b50) continue;
            const localNameLength = view.getUint16(localHeaderOffset + 26, true);
            const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
            const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
            if (dataStart + compressedSize > bytes.length) continue;

            const entry = { name, method, compressedSize, dataStart };
            if (!bestEntry || compressedSize > bestEntry.compressedSize) {
                bestEntry = entry;
            }
        }

        return bestEntry || null;
    }

    async _inflateRawDeflate(bytes) {
        if (typeof DecompressionStream !== 'function') {
            throw new Error('NovelAI 返回 ZIP，但当前浏览器缺少原生解压能力');
        }

        const tryInflate = async (format) => {
            const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
            const buffer = await new Response(stream).arrayBuffer();
            return new Uint8Array(buffer);
        };

        try {
            return await tryInflate('deflate-raw');
        } catch (err) {
            try {
                return await tryInflate('deflate');
            } catch (fallbackErr) {
                throw err;
            }
        }
    }

    _buildNovelAIPayload(options, config) {
        const appKey = String(options.app || '').trim().toLowerCase();
        const rawPrompt = this._joinPrompt([
            config.fixedPrompt,
            options.prompt,
            config.fixedPromptEnd
        ]);
        const rawNegativePrompt = this._joinPrompt([
            config.negativePrompt,
            options.negativePrompt
        ]);
        const prompt = rawPrompt;
        const negativePrompt = rawNegativePrompt;
        const seed = Number(options.seed ?? config.seed);
        const appDefaults = this._getAppDefaultSize(appKey);
        let width = Number(options.width || config.width);
        let height = Number(options.height || config.height);
        let scale = Number(options.scale ?? config.scale);
        let steps = Number(options.steps || config.steps);
        const cfgRescale = Number(options.cfgRescale ?? config.cfgRescale);
        const novelAIReferences = this._normalizeNovelAIReferences(options);
        if (appKey === 'honey') {
            if (!Number.isFinite(width) || !Number.isFinite(height) || width < 512 || height < 768) {
                width = appDefaults.width;
                height = appDefaults.height;
            }
            if (!Number.isFinite(steps) || steps < 20) {
                steps = 28;
            }
            if (!Number.isFinite(scale) || scale < 1) {
                scale = 7;
            }
        }
        if (appKey === 'weibo' && this._isNovelAIV4Model(config.model)) {
            const isSquare = width === height;
            if (!Number.isFinite(width) || !Number.isFinite(height) || (isSquare && width < 1024)) {
                width = 1024;
                height = 1024;
            }
        }
        const resolvedSeed = Number.isFinite(seed) && seed >= 0
            ? Math.floor(seed)
            : Math.floor(Math.random() * 4294967295);

        const parameters = {
            width,
            height,
            scale,
            sampler: config.sampler,
            steps,
            n_samples: 1,
            ucPreset: 0,
            qualityToggle: false,
            sm: false,
            sm_dyn: false,
            cfg_rescale: cfgRescale,
            noise_schedule: config.schedule,
            seed: resolvedSeed,
            negative_prompt: negativePrompt
        };

        if (this._isNovelAIV4Model(config.model)) {
            Object.assign(parameters, {
                params_version: 3,
                dynamic_thresholding: false,
                controlnet_strength: 1,
                legacy: false,
                add_original_image: false,
                legacy_v3_extend: false,
                v4_prompt: {
                    caption: {
                        base_caption: prompt,
                        char_captions: []
                    },
                    use_coords: false,
                    use_order: true
                },
                v4_negative_prompt: {
                    caption: {
                        base_caption: negativePrompt,
                        char_captions: []
                    },
                    legacy_uc: false
                }
            });

            if (novelAIReferences.length > 0) {
                Object.assign(parameters, {
                    director_reference_images: novelAIReferences.map(item => item.image),
                    director_reference_descriptions: novelAIReferences.map(() => ({
                        caption: {
                            base_caption: 'character&style',
                            char_captions: []
                        },
                        legacy_uc: false
                    })),
                    director_reference_information_extracted: novelAIReferences.map(item => item.informationExtracted),
                    director_reference_strength_values: novelAIReferences.map(item => item.strength),
                    director_reference_secondary_strength_values: novelAIReferences.map(() => 0)
                });
            }
        }

        return {
            input: prompt,
            model: config.model,
            action: 'generate',
            parameters
        };
    }

    previewFinalPrompt(options = {}) {
        const config = this.getConfig(options);
        const prompt = String(options.prompt || '').trim();
        return {
            provider: config.provider,
            app: String(options.app || '').trim().toLowerCase(),
            model: config.model,
            fixedPrompt: config.fixedPrompt,
            aiPrompt: prompt,
            fixedPromptEnd: config.fixedPromptEnd,
            positivePrompt: config.provider === 'siliconflow'
                ? this._joinPrompt([config.fixedPrompt, prompt, config.fixedPromptEnd], '，')
                : this._joinPrompt([config.fixedPrompt, prompt, config.fixedPromptEnd]),
            negativePrompt: this._joinPrompt([config.negativePrompt, options.negativePrompt]),
            seed: Number(options.seed ?? config.seed)
        };
    }

    async _generateNovelAI(options, config) {
        const prompt = String(options.prompt || '').trim();
        if (!prompt) throw new Error('缺少生图提示词');

        const endpoint = `${this._resolveNovelAIEndpoint(config)}/ai/generate-image`;
        const payload = this._buildNovelAIPayload(options, config);
        this._debugNovelAIRequest({ endpoint, payload, config, options });
        const queueInfo = await this._waitForNovelAIQueueTurn(config, options);
        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${config.apiKey}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/x-zip-compressed, image/png, application/json'
                },
                body: JSON.stringify(payload),
                signal: options.signal
            });

            if (!response.ok) {
                const text = await response.text().catch(() => '');
                const hint = response.status >= 500
                    ? `；当前参数 model=${config.model}, sampler=${config.sampler}, schedule=${config.schedule}，可先用 native + k_euler 测试`
                    : '';
                throw new Error(`NovelAI 请求失败 (${response.status})${hint}${text ? `: ${text.slice(0, 180)}` : ''}`);
            }

            const contentType = String(response.headers.get('content-type') || '').toLowerCase();
            let imageData = '';
            if (contentType.includes('application/json')) {
                const payload = await response.json();
                imageData = this._extractBase64Image(payload);
            } else {
                imageData = await this._readZipImage(response);
            }
            if (!imageData) throw new Error('NovelAI 未返回可用图片');
            const imageInfo = await this._waitForImageDecode(imageData).catch((err) => {
                throw new Error(`NovelAI 返回图片不可用: ${err?.message || err}`);
            });
            return {
                provider: 'novelai',
                model: config.model,
                prompt,
                width: imageInfo.width,
                height: imageInfo.height,
                requestedWidth: Number(payload?.parameters?.width || config.width),
                requestedHeight: Number(payload?.parameters?.height || config.height),
                steps: Number(payload?.parameters?.steps || config.steps),
                sampler: config.sampler,
                schedule: config.schedule,
                scale: Number(payload?.parameters?.scale ?? config.scale),
                seed: Number(payload?.parameters?.seed ?? -1),
                imageData,
                imageUrl: imageData
            };
        } finally {
            await this._finishNovelAIQueue(queueInfo);
        }
    }

    async _generateSiliconflow(options, config) {
        const prompt = String(options.prompt || '').trim();
        if (!prompt) throw new Error('缺少生图提示词');

        const response = await fetch('https://api.siliconflow.cn/v1/images/generations', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${config.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: config.model,
                prompt: this._joinPrompt([config.fixedPrompt, prompt, config.fixedPromptEnd], '，'),
                negative_prompt: this._joinPrompt([config.negativePrompt, options.negativePrompt]),
                image_size: `${Number(options.width || config.width)}x${Number(options.height || config.height)}`,
                batch_size: 1,
                num_inference_steps: Number(options.steps || config.steps),
                guidance_scale: Number(options.scale ?? config.scale)
            })
        });
        const text = await response.text();
        let payload = null;
        try { payload = text ? JSON.parse(text) : null; } catch (e) { payload = null; }
        if (!response.ok) {
            const msg = payload?.message || payload?.error?.message || payload?.error || text || '';
            throw new Error(`SiliconFlow 请求失败 (${response.status})${msg ? `: ${String(msg).slice(0, 180)}` : ''}`);
        }
        const imageUrl = String(payload?.images?.[0]?.url || '').trim();
        if (!imageUrl) throw new Error('SiliconFlow 未返回图片 URL');
        return {
            provider: 'siliconflow',
            model: config.model,
            prompt,
            width: Number(options.width || config.width),
            height: Number(options.height || config.height),
            requestedWidth: Number(options.width || config.width),
            requestedHeight: Number(options.height || config.height),
            steps: Number(options.steps || config.steps),
            scale: Number(options.scale ?? config.scale),
            imageData: imageUrl,
            imageUrl
        };
    }

    _sdModelsCache = null;
    _sdModelsCacheTime = 0;
    _sdModelsCacheTtl = 5 * 60 * 1000;

    async fetchSdModels(baseUrl) {
        const now = Date.now();
        if (this._sdModelsCache && now - this._sdModelsCacheTime < this._sdModelsCacheTtl) {
            return this._sdModelsCache;
        }

        const url = this._resolveSdApiUrl(baseUrl, '/sdapi/v1/sd-models');
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`SD模型列表获取失败 (${response.status})`);
        }

        const models = await response.json();
        this._sdModelsCache = models;
        this._sdModelsCacheTime = now;
        return models;
    }

    _resolveSdApiUrl(baseUrl, path) {
        const base = String(baseUrl || '').trim().replace(/\/+$/, '');
        const p = String(path || '').replace(/^\/+/, '');
        return `${base}/${p}`;
    }

    buildSdModelHashMap(models) {
        const map = new Map();
        for (const model of models) {
            const name = String(model?.model_name || model?.name || '').trim();
            const hash = String(model?.sd_model_hash || model?.hash || '').trim();
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

        const baseUrl = String(config.sdUrl || '').trim();
        if (!baseUrl) throw new Error('未配置 Stable Diffusion 服务地址');

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

        if (modelHash) {
            payload.sd_model_hash = modelHash;
        }
        if (cfgRescale > 0) {
            payload.cfg_rescale = cfgRescale;
        }

        const url = this._resolveSdApiUrl(baseUrl, '/sdapi/v1/txt2img');
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload),
            signal: options.signal
        });

        const text = await response.text();
        let result = null;
        try { result = text ? JSON.parse(text) : null; } catch (e) { result = null; }

        if (!response.ok) {
            const msg = result?.error?.message || result?.message || text || '';
            throw new Error(`Stable Diffusion 请求失败 (${response.status})${msg ? `: ${String(msg).slice(0, 180)}` : ''}`);
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
        return '';
    }
}
