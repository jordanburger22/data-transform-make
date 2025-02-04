const express = require('express');
const morgan = require('morgan');
const makeRouter = require('./routes/makeRouter');
require('dotenv').config();
const cors = require('cors');

const app = express();
const PORT = process.env.PORT;

// Use a raw text parser so we can inspect and sanitize the body.
app.use(express.text({ type: '*/*', limit: '5mb' }));


// Middleware to log the raw body (for debugging)
app.use((req, res, next) => {
  console.log('Raw body:', req.body);
  next();
});

// Custom middleware to sanitize and parse the raw body as JSON
app.use((req, res, next) => {
  try {
    if (typeof req.body === 'string') {
      // Remove null bytes and trim the string.
      const sanitizedBody = req.body.replace(/\0/g, '').trim();
      
      // If the sanitized body is empty, set it to an empty object.
      if (!sanitizedBody) {
        req.body = {};
      } else {
        req.body = JSON.parse(sanitizedBody);
      }
    }
    next();
  } catch (error) {
    console.error('JSON parsing error:', error);
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }
});

// Standard middleware
app.use(morgan('dev'));
app.use(cors());

// Your route for processing orders
app.use('/wattsbags', makeRouter);

// Optional: Final error-handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

app.listen(PORT, () => {
  console.log(`Server running on PORT: ${PORT}`);
});
