'use strict';

const EventEmitter = require('events');

const am = require('am');

const { Session } = require('./lib/launch');
const utils = require('./lib/utils');

const CHROME_EXE = process.env.CHROME_EXE || '/usr/bin/google-chrome'
const PROFILE_DIR = process.env.PROFILE_DIR || false;
const USE_XVFB = !!process.env.USE_XVFB
const HTTP_PROXY = process.env.HTTP_PROXY || undefined;

const NAV_TIMEOUT = 30.0 * 1000
const NAV_COMPLETE_EVENT = 'networkidle2'


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


    const instrumentTarget = async (target) => {
        console.log("new target", target._targetId, target.type());
        const tcdp = await target.createCDPSession();

        if (["page", "other"].includes(target.type())) {
            const rt = new RequestTracker();
            rt.on('request', (request) => {
                console.log(request.id, request.params.type, request.params.frameId);
            });
            [
                'Network.requestWillBeSent',
                'Network.responseReceived',
                'Network.loadingFinished',
                'Network.loadingFailed',
            ].forEach((eventName) => {
                tcdp.on(eventName, (params) => {
                    rt.update(eventName, params);
                });
            });

            tcdp.on('Console.messageAdded', (params) => {
                const { source, level, text, url } = params;
                console.log(source, url, level, text);
            });

            tcdp.on('DOM.childNodeInserted', (params) => {
                const { node } = params;
                console.log("node", node.frameId, node.nodeName);
            });
            await Promise.all([
                tcdp.send('Network.enable'),
                tcdp.send('Console.enable'),
                tcdp.send('DOM.enable'),
                tcdp.send('Page.enable'),
            ]);
        }
        await tcdp.send('Target.setAutoAttach', {
            autoAttach: true,
            waitForDebuggerOnStart: false,
            flatten: true,
        });
        tcdp.on('Target.attachedToTarget', async (params) => {
            const { targetInfo } = params;
            const target = browser._targets.get(targetInfo.targetId);
            await instrumentTarget(target);
        });
        try {
            await tcdp.send('Runtime.runIfWaitingForDebugger');
        } catch { }

    };


    browser.on('targetcreated', async (target) => {
        if (!["page", "other"].includes(target.type())) {
            return;
        }
        const rt = new RequestTracker();
        rt.on('request', (request) => {
            console.log(target.type(), request.id, request.params);
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
    });

    //instrumentTarget(browser.target());

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
        });
    } catch (err) {
        console.error("error while browsing:", err);
        exitStatus = 1;
    }
    process.exit(exitStatus);
})