import {
  ModuleConstructor,
  LogFunction,
} from "@internal-staff-portal/backend-shared";
import { AuthInstance, IConfig, sendData } from "@authfunctions/express";
import RedisClient, { RedisOptions } from "ioredis";
import cors from "cors";
import express, { Express } from "express";

//the options provided to the core
export interface CoreOptions {
  modules: ModuleConstructor[];
  port: number;
  logger: LogFunction;
  auth: IConfig & { tokenSetName: string };
  redis: RedisOptions;
}

//temporary user and token database
const users: any[] = [];

//hacky way to fix ts interpreting RedisClient as a namespace
class Redis extends RedisClient {}

//the main core class
export class Core {
  private modules: string[];
  private paths: string[];
  private app: Express;
  private auth: AuthInstance;
  private logger: LogFunction;
  private redisClient: Redis;

  constructor(options: CoreOptions) {
    //init array of all module names
    this.modules = ["Auth"];

    //init array of all module paths
    this.paths = ["/auth"];

    //set the logger
    this.logger = options.logger;

    //init express app
    this.app = initExpress(options.port, this.logger);

    //init the redis client
    this.redisClient = initRedis(options.redis, this.logger);

    //init the auth module
    this.auth = initAuth(options, this.redisClient, this.logger);

    //use auth module router
    this.app.use("/auth", this.auth.Router);

    //register all modules
    options.modules.forEach((module) => this.addModule(module));
  }

  //add/register a module
  private addModule(moduleConstructor: ModuleConstructor) {
    //constructe module
    const module = moduleConstructor({
      auth: {
        sendData: sendData,
        validateMiddleware: this.auth.validateMiddleware,
      },
      logger: this.logger,
    });

    //throw error if path or name of module is alredy used
    if (
      this.paths.includes(module.path) ||
      this.modules.includes(module.name)
    ) {
      throw new Error(
        `A module with the path "${module.path}" or the name "${module.name}" is alredy used!`,
      );
    }

    //add path to module paths
    this.paths.push(module.path);

    //add name to module names
    this.modules.push(module.name);

    //use the router of the module
    this.app.use(module.path, module.router);
  }
}

//init express app
function initExpress(port: number, logger: LogFunction) {
  //create app
  const app = express();

  //use json parser
  app.use(express.json());

  //use cors
  app.use(cors());

  //start express app
  app.listen(port, () =>
    logger("info", `Internal-Staff-Portal instance on Port ${port}!`),
  );

  //return app
  return app;
}

//init redis client
function initRedis(options: RedisOptions, logger: LogFunction) {
  //create client
  const redis = new RedisClient(options);

  //listen on connection event
  redis.connect(() => {
    logger("info", "Connected to Redis instance!");
  });

  //return redis instance
  return redis;
}

//init auth instance
function initAuth(
  { auth: authOptions }: CoreOptions,
  redis: Redis,
  logger: LogFunction,
) {
  //create instance
  const auth = new AuthInstance(authOptions);

  //set logger
  auth.logger(logger);

  auth.use("getUserByMail", ({ email }) => {
    const user = users.find((usr) => usr.email === email);
    return [false, user];
  });

  auth.use("getUserByName", ({ username }) => {
    const user = users.find((usr) => usr.username === username);
    return [false, user];
  });

  auth.use("storeUser", (user) => {
    users.push(user);
    return [false];
  });

  auth.use("checkToken", async ({ token }) => {
    try {
      //check if the token exists
      const included = await redis.sismember(authOptions.tokenSetName, token);

      //no error
      return [false, Boolean(included)];
    } catch (err) {
      //log error
      logger("error", String(err));

      //return error
      return [true, null];
    }
  });

  auth.use("deleteToken", async ({ token }) => {
    try {
      //remove the token
      await redis.srem(authOptions.tokenSetName, token);

      //no error
      return [false];
    } catch (err) {
      //log error
      logger("error", String(err));

      //return error
      return [true];
    }
  });

  //store a token in the redis db
  auth.use("storeToken", async ({ token }) => {
    try {
      //store the token
      await redis.sadd(authOptions.tokenSetName, token);

      //no error
      return [false];
    } catch (err) {
      //log error
      logger("error", String(err));

      //return error
      return [true];
    }
  });

  //return auth instance
  return auth;
}
