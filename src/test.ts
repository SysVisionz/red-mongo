import RedMongo from './index'
import Redis from 'ioredis'
import mongoose from 'mongoose'


RedMongo(mongoose, Redis)

RedMongo