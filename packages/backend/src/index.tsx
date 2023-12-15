require('dotenv').config()

import http from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import * as React from 'react';
import ReactDOMServer from 'react-dom/server';
import fs from 'fs';
import path from 'path';
import HTMLParser from 'node-html-parser';
import { App, FrontendController, controllerRef } from '@skyslit/ark-frontend';
import { MongoClient, Collection } from 'mongodb';
import jwt from 'jsonwebtoken';
import moment from 'moment';
import utilsImp from './utils';
import UrlPattern from 'url-pattern';

export const utils = utilsImp;


declare global {
    namespace Express {
      interface Request {
        requestContext: RequestContext
      }
    }
}

function extractFrontendContext(c: RequestContext) {
    const { currentUser, isAuthenticated, token } = c;

    return {
        currentUser,
        isAuthenticated,
        token
    }
}

export class ServerInstance {
    static instance: ServerInstance;
    static getInstance() {
        if (!ServerInstance.instance) {
            ServerInstance.instance = new ServerInstance();
        }

        return ServerInstance.instance;
    }

    database?: MongoClient;
    httpServer: http.Server;
    app: express.Express;
    port: number = 8081;
    functions: any = {};
    auth = {
        jwtSecret: '77PjsGGRSkemFS@q$aAinTS',
        jwtSignOpts: {
            expiresIn: '1d',
        },
        createCookieOptions: () => {
            return {
                expires: moment.utc().add(23, 'hours').toDate()
            }
        }
    };

    setPort(p: number) {
        this.port = p;
    }

    constructor() {
        this.app = express();
        this.httpServer = http.createServer(this.app);

        this.app.use(morgan('dev'));
        this.app.use(cookieParser());

        this.app.use(express.json());
        this.app.use(express.urlencoded());
        this.app.use(express.text());
        this.app.use(express.raw());
        this.app.use(
            '/_browser',
            express.static(path.join(__dirname, '../_browser'))
        );
        this.app.use(
            '/assets',
            express.static(path.join(__dirname, '../assets'))
        );

        /** Attach context */
        this.app.use(async (req, res, next) => {
            let isAuthenticated: boolean = false;
            let currentUser: any = null;
            let authorization = decodeURIComponent(req.cookies['authorization'] || '');
            if (authorization) {
                authorization = authorization.replace('Bearer', '').trim();
                if (authorization) {
                    const payload = jwt.verify(authorization, this.auth.jwtSecret);
                    if (payload) {
                        currentUser = payload;
                    }
                }
            }

            isAuthenticated = Boolean(currentUser);

            req.requestContext = createRequestContext({
                token: req.cookies['authorization'],
                isAuthenticated,
                currentUser,
                setCurrentUser: (user) => {
                    if (user) {
                        /** Login */
                        /** Delete password */
                        delete user.password;

                        const token = jwt.sign(user, this.auth.jwtSecret, this.auth.jwtSignOpts);

                        let cookieOpts: any = this?.auth?.createCookieOptions && this?.auth?.createCookieOptions();

                        if (!cookieOpts) {
                            cookieOpts = {};
                        }

                        res.cookie(
                            'authorization',
                            `Bearer ${token}`,
                            cookieOpts
                        );
                    } else {
                        console.log('Logging out...');
                        /** Logout */
                        let cookieOpts: any = this?.auth?.createCookieOptions && this?.auth?.createCookieOptions();

                        if (!cookieOpts) {
                            cookieOpts = {};
                        }

                        cookieOpts.expires = moment.utc().add(-5, 'days').toDate()

                        if (!cookieOpts) {
                            cookieOpts = {};
                        }

                        res.cookie(
                            'authorization',
                            `null`,
                            cookieOpts
                        );
                    }
                }
            });
            next();
        })

        this.app.post('/__backend/__managed/:functionPath(*)', async (req, res, next) => {
            const { functionPath } = req.params;

            try {
                const result = await invokeBackendFunction(req.requestContext, functionPath, ...req.body.args);
                return res.json(result);
            } catch (e: any) {
                return res.status(500).json({
                    message: e?.message
                })
            }
        });

        this.app.post('/__backend/__context', async (req, res) => {
            res.json(extractFrontendContext(req.requestContext))
        });

        this.app.post('/__backend/__context/logout', async (req, res) => {
            req.requestContext.setCurrentUser(null);
            res.json({ ack: true });
        });
    }
}

const instance = ServerInstance.getInstance();

export async function createServer(handler?: (instance: ServerInstance) => void | Promise<void>, instance?: ServerInstance): Promise<ServerInstance> {
    if (!instance) {
        instance = ServerInstance.getInstance();
    }

    const MONGO_CONNECTION_STRING = process.env['MONGO_CONNECTION_STRING'];

    if (MONGO_CONNECTION_STRING) {
        console.log('Connecting to db...');
        /** Connect to MongoDB */
        instance.database = new MongoClient(MONGO_CONNECTION_STRING);
        await instance.database.connect();
        console.log('Connected to db');
    }

    if (handler) {
        await Promise.resolve(handler(instance));
    }

    instance.app.get('/*', (req, res, next) => {
        const config = controllerRef.arkConfig;

        if (Array.isArray(config.routes)) {
            const currentPath = req.path;
            const matchingPath = config.routes.find((route: any) => {
                const pattern = new UrlPattern(route.path);
                return pattern.match(currentPath);
            });

            // TODO: Do this only for dev env (BUT CURRENTLY ENABLED FOR ALL)
            res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate"); // HTTP 1.1.
            res.setHeader("Pragma", "no-cache"); // HTTP 1.0.
            res.setHeader("Expires", "0"); // Proxies.

            const shouldRenderOnServer = matchingPath?.ssr === true

            const htmlFilePath = path.join(__dirname, '../client.html');
            const htmlContent = fs.readFileSync(htmlFilePath, 'utf-8');
            const htmlContentNode = HTMLParser.parse(htmlContent);

            const passThruContext = extractFrontendContext(req.requestContext);
            const controller = new FrontendController();

            controller.applets = controllerRef.applets;
            controller.arkConfig = controllerRef.arkConfig;
            controller.registeredComponents = controllerRef.registeredComponents;

            controller.context = passThruContext as any;

            if (shouldRenderOnServer === true) {
                let helmetContext: any = {};
                const serverRenderedContent = ReactDOMServer.renderToString(<App helmetContext={helmetContext} initialPath={req.path} controller={controller} />);
                let headContent: string[] = [];
                try {
                    headContent = Object.keys(helmetContext?.helmet || {}).reduce(
                        (acc: any[], item) => {
                            let c: string;
                            try {
                                c = helmetContext.helmet[item].toString();
                            } catch (e) {
                                console.error(e);
                            }

                            // @ts-ignore
                            if (c) {
                                acc.push(c);
                            }

                            return acc;
                        },
                        []
                    );

                    let i = 0;
                    for (i = 0; i < headContent.length; i++) {
                        const headNode = htmlContentNode
                            .querySelector('head');

                        if (headNode) {
                            headNode.appendChild(HTMLParser.parse(headContent[i]));
                        }
                    }
                } catch (e) {
                    console.error(e);
                }


                const rootDiv = htmlContentNode.querySelector('#root');
                if (rootDiv) {
                    rootDiv.set_content(serverRenderedContent);
                }
            }

            const headCon = htmlContentNode.querySelector('head');
            if (headCon) {
                const scriptNode = HTMLParser.parse(
                    `<script>globalThis.___ark_hydrated_state___=${JSON.stringify({ ...passThruContext, shouldHydrate: shouldRenderOnServer })};</script>`
                );
                headCon.appendChild(scriptNode);
            }

            res.send(htmlContentNode.toString());
            return;
        }

        next();
    })

    instance.app.listen(instance.port, undefined as any, undefined as any, () => {
        console.log(`Listing to ${instance?.port}`)
    });

    return instance;
}

export function registerBackendComponent(_moduleId: string, module: any) {
    const instance = ServerInstance.getInstance();

    const arkCompType = module?.prototype?.arkCompType;

    switch (arkCompType || module?.type) {
        case 'express-route': {
            const { path, method, handlers } = module.payload as any;
            const instance = ServerInstance.getInstance();
            // @ts-ignore
            instance.app[method as any](path, handlers);
            break;
        }
        case 'backend-function': {
            instance.functions[_moduleId] = module;
            break;
        }
    }
}

export function createRoute(method: 'get' | 'post' | 'put' | 'delete', path: string, ...handlers: express.Handler[]) {
    return {
        type: 'express-route',
        payload: {
            handlers,
            method,
            path
        }
    }
}

type RequestContext = { setCurrentUser: (user: any) => void, currentUser: any, isAuthenticated: boolean, token: string };
export function createRequestContext(c: RequestContext) {
    return c;
}
type BackendFunction = (...args: any) => Promise<any>
export function createBackendFunction(fn: BackendFunction) {
    fn.prototype.arkCompType = 'backend-function';
    return fn
}
export const useFunctionContext = (t: any): RequestContext => {
    if (!t) {
        throw new Error('Request context is undefined. Make sure you are invoking the function with proper context.');
    }
    // @ts-ignore
    return t;
}

export async function invokeBackendFunction(requestContext: Partial<RequestContext>, functionPath: string, ...args: any) {
    const instance = ServerInstance.getInstance();
    try {
        if (functionPath) {
            const fnPayload = instance.functions[functionPath];
            if (fnPayload) {
                const result = await Promise.resolve(fnPayload.call(requestContext, ...args));
                return result;
            }
        }

        throw new Error(`No such function exists. Looking for function '${functionPath}'`);
    } catch (e) {
        throw e;
    }
}

/* -------------------------------------------------------------------------- */
/*                                    Data                                    */
/* -------------------------------------------------------------------------- */

export function data(collectionName: string, dbName?: string): Collection {
    if (!instance.database) {
        throw new Error('Database is not available. Please check the environment variable.');
    }

    return instance.database.db(dbName).collection(collectionName);
}

/* -------------------------------------------------------------------------- */
/*                                   Config                                   */
/* -------------------------------------------------------------------------- */

export function loadConfig(config: any) {
    const properties = config?.properties || [];

    return {
        getValue(propertyName: string, defaultVal?: any): any {
            const p = properties.find((p: any) => p?.name === propertyName);
            return p?.value || defaultVal;
        }
    }
}
