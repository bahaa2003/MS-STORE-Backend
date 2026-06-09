'use strict';

const { Router } = require('express');
const whatsappController = require('./whatsapp.controller');
const authenticate = require('../../shared/middlewares/authenticate');
const authorize = require('../../shared/middlewares/authorize');

const router = Router();

router.use(authenticate);
router.use(authorize('ADMIN'));

router.get('/status', whatsappController.getStatus);
router.post('/reconnect', whatsappController.reconnect);
router.post('/reset', whatsappController.reset);

module.exports = router;
