const express = require('express')
const morgan = require('morgan')
const makeRouter = require('./routes/makeRouter')
require('dotenv').config()
const app = express()
const PORT = process.env.PORT
const cors = require('cors')

app.use(express.json())
app.use(morgan('dev'))
app.use(cors())


app.use('/wattsbags', makeRouter)




app.listen(PORT, (err) => console.log(`Server running on PORT: ${PORT}`))