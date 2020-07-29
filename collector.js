'use strict';

const EventEmitter = require('events');

const am = require('am');

const { Session } = require('./lib/launch');
const utils = require('./lib/utils');

const CHROME_EXE = process.env.CHROME_EXE || '/usr/bin/google-chrome'
const PROFILE_DIR = process.env.PROFILE_DIR || false;
const USE_XVFB = !!process.env.USE_XVFB
const HTTP_PROXY = process.env.HTTP_PROXY || undefined;

const NAV_TIMEOUT = 5.0 * 1000
const NAV_COMPLETE_EVENT = 'load'


class RawRequest {
    constructor(requestId) {
        this.id = requestId;
        this.events = [];
        this.params = {};
        this.done = false;
    }

    update(eventName, inputParams) {
        this.events.push(eventName);

        Object.entries(inputParams).forEach(([key, value]) => {
            this.params[key] = value;
        });

        if (eventName === "Network.loadingFinished" || eventName === "Network.loadingFailed") {
            this.done = true;
        }

        return this;
    }
}

class RequestTracker extends EventEmitter {
    constructor() {
        super();
        this._rmap = new Map();
    }

    update(eventName, inputParams) {
        const { requestId } = inputParams;
        if (!requestId) throw Error("request id missing");

        let req = this._rmap.get(requestId);
        if (!req) {
            req = new RawRequest(requestId);
            this._rmap.set(requestId, req);
        }

        req.update(eventName, inputParams);

        if (req.done) {
            this._rmap.delete(requestId);
            this.emit('request', req);
        }

        return req;
    }
}


const MetricsCollector = async (browser) => {
    let frameMetricsMap = new Map();
    const getFrameMetrics = (frame) => {
        let metrics = frameMetricsMap.get(frame);
        if (!metrics) {
            metrics = {
                requests: [],
                consoles: [],
            };
            frameMetricsMap.set(frame, metrics);
        }
        return metrics;
    };
    const logRequest = (request) => {
        const frame = request.frame();
        const failure = request.failure();
        const response = request.response();
        const url = request.url();

        const record = {
            url,
            type: request.resourceType(),
            headers: request.headers(),
        };

        if (failure) {
            record.ok = false;
            record.error = failure.errorText;
        } else if (response) {
            record.ok = true;
            record.status = response.status();

            const endpoint = response.remoteAddress();
            if (endpoint.ip) {
                record.endpoint = endpoint;
            }

            const tlsInfo = response.securityDetails();
            if (tlsInfo) {
                record.security = tlsInfo;
            }
        } else {
            record.ok = undefined; // file_not_found
        }

        getFrameMetrics(frame).requests.push(record);
    };

    const rt = new RequestTracker();
    rt.on('request', (request) => {
        console.log(request.id, request.params.type, JSON.stringify(request.events), request.params.request && request.params.request.url);
    });

    const sessionSet = new WeakSet();
    const instrumentSession = async (cdp) => {
        const sessionId = cdp._sessionId;
        const targetType = cdp._targetType;
        if (sessionSet.has(cdp)) {
            console.log("old session", sessionId, targetType);
            return;
        }
        console.log("new session", sessionId, targetType);

        if (["page", "iframe"].includes(targetType)) {
            [
                'Network.requestWillBeSent',
                'Network.responseReceived',
                'Network.loadingFinished',
                'Network.loadingFailed',
            ].forEach((eventName) => {
                cdp.on(eventName, (params) => {
                    rt.update(eventName, params);
                });
            });

            cdp.on('Console.messageAdded', (params) => {
                const { message: { source, level, text, url } } = params;
                console.log(source, url, level, text);
            });

            cdp.on('DOM.insertChildNode', (params) => {
                console.log("DOM INSERT", params);
            });
            cdp.on('DOM.documentUpdated', async () => {
                console.log("DOM UPDATE", await cdp.send('DOM.getDocument', { depth: 1, pierce: true }));
            })
            await Promise.all([
                cdp.send('Network.enable'),
                cdp.send('Console.enable'),
                cdp.send('DOM.enable'),
                cdp.send('Page.enable'),
            ]);
        }
        await cdp.send('Target.setAutoAttach', {
            autoAttach: true,
            waitForDebuggerOnStart: true,
            flatten: true,
        });
        cdp.on('Target.attachedToTarget', async (params) => {
            const { sessionId, targetInfo } = params;
            console.log("COLLECTOR-DEBUG: Target.attachedToTarget:", sessionId, targetInfo.type, targetInfo.targetId);
            const cdp = browser._connection._sessions.get(sessionId);
            await instrumentSession(cdp);
        });
        try {
            await cdp.send('Runtime.runIfWaitingForDebugger');
        } catch { }
        console.log(`DONE INSTRUMENTING SESSION ${sessionId}`)
    };

    const rootSession = await browser.target().createCDPSession();
    instrumentSession(rootSession);


    /*browser.on('targetcreated', async (target) => {
        const targetType = target._targetInfo.type;
        const targetId = target._targetId;
        if (!["page", "iframe"].includes(targetType)) {
            return;
        }
        const rt = new RequestTracker();
        rt.on('request', (request) => {
            console.log(targetType, targetId, request.id, request.params.type, JSON.stringify(request.events), request.params.request && request.params.request.url);
        });

        const cdp = await target.createCDPSession();
        [
            'Network.requestWillBeSent',
            'Network.responseReceived',
            'Network.loadingFinished',
            'Network.loadingFailed',
        ].forEach((eventName) => {
            cdp.on(eventName, (params) => {
                rt.update(eventName, params);
            });
        });

        cdp.on('Console.messageAdded', (params) => {
            const { source, level, text, url } = params;
            console.log(source, url, level, text);
        });

        cdp.on('DOM.childNodeInserted', (params) => {
            const { node } = params;
            console.log("node", node.frameId, node.nodeName);
        });

        await Promise.all([
            cdp.send('Network.enable'),
            cdp.send('Console.enable'),
            cdp.send('DOM.enable'),
            cdp.send('Page.enable'),
            cdp.send('Log.enable'),
        ]);
        console.log(`DONE INSTRUMENTING TARGET ${target._targetId}`)
    });*/

    /*browser.on('targetcreated', async (target) => {
        if (target.type() !== "page") {
            console.log(`skipping target of type ${target.type()}`);
            return;
        }

        const page = await target.page();
        page.on('requestfinished', logRequest);
        page.on('requestfailed', logRequest);
        console.log(`instrumented requests on page ${target._targetId}`)
    });*/

    return () => {
        const oldResults = frameMetricsMap;
        frameMetricsMap = new Map();
        return oldResults;
    };
};


am(async (...urls) => {
    const session = new Session();
    session.useBinary(CHROME_EXE);

    if (PROFILE_DIR === false) {
        session.useTempProfile();
    }

    if (USE_XVFB) {
        session.useXvfb();
    }

    if (HTTP_PROXY) {
        session.useProxyServer(HTTP_PROXY);
    }

    let exitStatus = 0;
    try {
        await session.run(async (browser) => {
            const collectMetrics = await MetricsCollector(browser);
            const page = await browser.newPage();

            for (const url of urls) {
                await utils.closeOtherPages(browser, page);
                console.log(`navigating ${page.target()._targetId} to ${url}`);
                await page.goto(url, {
                    timeout: NAV_TIMEOUT,
                    waitUntil: NAV_COMPLETE_EVENT,
                });

                const metrics = collectMetrics();
                for (const [frame, { requests, consoles }] of metrics.entries()) {
                    if (frame) {
                        const isMain = (frame.parentFrame() === null) && !frame.isDetached();
                        console.log(`FRAME: ${frame.name()} url=${frame.url()} main=${isMain}`);
                    } else {
                        console.log("NULL FRAME");
                    }
                    for (const req of requests) {
                        console.log(req);
                    }
                }
            }

            await utils.timeoutIn(60 * 1000);
        });
    } catch (err) {
        console.error("error while browsing:", err);
        exitStatus = 1;
    }
    process.exit(exitStatus);
})