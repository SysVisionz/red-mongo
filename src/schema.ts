import Redis from "ioredis";
import mongoose from "mongoose";

export default class Schema{
    ref: {
        schemaObject: {[key: string]: any}, 
        options: {}
    }
    redis: Redis
    mongoose: typeof mongoose
    constructor(name: string, schemaObject: {[key: string]: any}, options: {}){
        this.redis = global.RedMongo.redis

        global.RedMongo.__Schemas[name] = {
            schemaObject,options
        }
        this.redis = global.RedMongo.redis;
        this.mongoose = global.RedMongo.mongoose
    }
    
}