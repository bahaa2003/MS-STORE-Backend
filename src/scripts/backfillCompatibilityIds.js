'use strict';

// Explicit operational script. It is intentionally never imported by app.js
// and must only be run against an approved non-production database.
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');
const { Product } = require('../modules/products/product.model');
const { Category } = require('../modules/categories/category.model');
const { Order } = require('../modules/orders/order.model');
const { getNextSequence } = require('../modules/orders/counter.model');
const crypto = require('crypto');

const assign = async (Model, key, counter, start) => {
    const rows = await Model.find({ $or: [{ [key]: null }, { [key]: { $exists: false } }] }).select('_id').lean();
    for (const row of rows) {
        const value = key === 'compatOrderId' ? `ID_${crypto.randomBytes(8).toString('hex')}` : await getNextSequence(counter, start);
        await Model.updateOne({ _id: row._id, $or: [{ [key]: null }, { [key]: { $exists: false } }] }, { $set: { [key]: value } });
    }
    return rows.length;
};
const run = async () => {
    await connectDB();
    const [products, categories, orders] = await Promise.all([
        assign(Product, 'compatProductId', 'compatProductId', 999),
        assign(Category, 'compatCategoryId', 'compatCategoryId', 1),
        assign(Order, 'compatOrderId'),
    ]);
    console.log(JSON.stringify({ products, categories, orders }));
    await mongoose.connection.close();
};
if (require.main === module) run().catch(async (error) => { console.error(error.message); await mongoose.connection.close(); process.exitCode = 1; });
module.exports = { assign };
