'use strict';
const router = require('express').Router(); const auth = require('../../shared/middlewares/resellerAuth'); const controller = require('./clientCompat.controller'); const { catchCompat } = require('./clientCompat.errors'); const { requireCompatOrderingAvailable } = require('./clientCompat.maintenance');
router.use((req, _res, next) => { req.clientCompatErrorFormat = true; next(); }, auth);
router.get('/profile', catchCompat(controller.getProfile)); router.get('/products', catchCompat(controller.listProducts)); router.get('/content/:parentId', catchCompat(controller.getContent)); router.post('/orders', requireCompatOrderingAvailable, catchCompat(controller.placeCanonicalOrder)); router.get('/newOrder/:productId/params', requireCompatOrderingAvailable, catchCompat(controller.placeOrder)); router.get('/check', catchCompat(controller.checkOrders));
module.exports = router;
