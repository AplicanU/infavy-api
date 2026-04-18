function addRoutesFromRouter(app, mountPath, router, docName = null) {
    // Ensure storage
    app.locals.apiEndpoints = app.locals.apiEndpoints || [];

    // Iterate the router stack to collect route definitions
    if (router && router.stack && Array.isArray(router.stack)) {
        router.stack.forEach((layer) => {
            if (layer.route && layer.route.path) {
                const methods = Object.keys(layer.route.methods || {});
                methods.forEach((m) => {
                    // Normalize path concatenation
                    const routePath = (mountPath + layer.route.path).replace(/\/+/g, '/');
                    app.locals.apiEndpoints.push({ method: m.toUpperCase(), url: routePath, doc: docName });
                });
            }
        });
    }

    // Mount the router on the app
    app.use(mountPath, router);
}

module.exports = function attachApis(app, routePrefix = '/api/v1') {
    // Ping endpoint
    app.get(`${routePrefix}/ping`, (req, res) => res.json({ ok: true, ts: Date.now() }));

    // import routers
    const healthRouter = require('./routes/health');
    const authRouter = require('./routes/auth');
    const heroRouter = require('./routes/home/hero');
    const gridRouter = require('./routes/home/grid');
    const nextRouter = require('./routes/home/up-next');
    const currentRouter = require('./routes/home/video');
    const similarRouter = require('./routes/home/similar');
    const channelsRouter = require('./routes/channels');
    const usersRouter = require('./routes/users');
    const videosRouter = require('./routes/videos');
    const watchlistRouter = require('./routes/watchlist');
    const subscriptionsRouter = require('./routes/subscriptions');
    const likesRouter = require('./routes/likes');
    const profilesRouter = require('./routes/profiles');
    const razorpayWebhookRouter = require('./routes/webhooks-razorpay');

    app.locals.apiEndpoints = app.locals.apiEndpoints || [];
    app.locals.apiEndpoints.push({ method: 'GET', url: `${routePrefix}/ping`, doc: null });
    

    // Mount health at /health (root)
    addRoutesFromRouter(app, '/health', healthRouter, null);
    

    // Mount API routers under the provided prefix and collect their routes
    addRoutesFromRouter(app, `${routePrefix}/auth`, authRouter, 'AUTH_API');
    addRoutesFromRouter(app, `${routePrefix}/home/hero`, heroRouter, 'HOME_API');
    addRoutesFromRouter(app, `${routePrefix}/home/grid`, gridRouter, 'HOME_API');
    addRoutesFromRouter(app, `${routePrefix}/home/up-next`, nextRouter, 'HOME_API');
    addRoutesFromRouter(app, `${routePrefix}/home/video`, currentRouter, 'HOME_API');
    addRoutesFromRouter(app, `${routePrefix}/home/similar`, similarRouter, 'HOME_API');
    addRoutesFromRouter(app, `${routePrefix}/channels`, channelsRouter, 'CHANNELS_API');
    addRoutesFromRouter(app, `${routePrefix}/videos`, videosRouter, 'VIDEOS_API');
    addRoutesFromRouter(app, `${routePrefix}/users`, usersRouter, 'AUTH_API');
    addRoutesFromRouter(app, `${routePrefix}/watchlist`, watchlistRouter, 'WATCHLIST_API');
    addRoutesFromRouter(app, `${routePrefix}/subscriptions`, subscriptionsRouter, 'SUBSCRIPTIONS_API');
    addRoutesFromRouter(app, `${routePrefix}/likes`, likesRouter, 'LIKES_API');
    addRoutesFromRouter(app, `${routePrefix}/profiles`, profilesRouter, 'AUTH_API');
    addRoutesFromRouter(app, `${routePrefix}/webhooks/razorpay`, razorpayWebhookRouter, null);
};
