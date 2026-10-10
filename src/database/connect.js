const mongoose = require('mongoose');
const logger = require('../utils/logger');

async function connectDatabase(uri) {
  mongoose.set('strictQuery', true);
  mongoose.connection.on('error', (error) => logger.error('MongoDB connection error', { message: error.message }));
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  logger.info('Connected to MongoDB');
  return mongoose.connection;
}

module.exports = { connectDatabase };
