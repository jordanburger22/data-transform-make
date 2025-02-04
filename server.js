const express = require('express');
const morgan = require('morgan');
const makeRouter = require('./routes/makeRouter');
require('dotenv').config();
const cors = require('cors');

const app = express();
const PORT = process.env.PORT;

// Log the raw body (for debugging)
// Use express.text() temporarily to capture raw text.
app.use(express.text({ type: '*/*' }));

app.use((req, res, next) => {
  console.log('Raw body:', req.body);
  next();
});

// Now try to parse JSON from the raw body
app.use((req, res, next) => {
  try {
    // If the body is already an object (because it's empty or already parsed), skip parsing.
    if (typeof req.body === 'string') {
      req.body = JSON.parse(req.body);
    }
    next();
  } catch (error) {
    console.error('JSON parsing error:', error);
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }
});

app.use(morgan('dev'));
app.use(cors());

app.use('/wattsbags', makeRouter);

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

app.listen(PORT, () => {
  console.log(`Server running on PORT: ${PORT}`);
});
