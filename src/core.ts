import {
  AuthInstance,
  IConfig,
  IUserData,
  sendData,
} from "@authfunctions/express";
import {
  ModuleConstructor,
  LogFunction,
  UserModel,
} from "@internal-staff-portal/backend-shared";
import cors from "cors";
import express, { Express } from "express";
import RedisClient, { RedisOptions } from "ioredis";
import { connect } from "mongoose";
import { join } from "path";

//the options provided to the core
export interface CoreOptions {
  modules: ModuleConstructor[];
  port: number;
  logger: LogFunction;
  auth: IConfig & { tokenSetName: string };
  redis: RedisOptions;
  mongoURI: string;
  adminKey: string;
}

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
  private adminKey: string;

  constructor(options: CoreOptions) {
    //init array of all module names
    this.modules = ["Auth"];

    //set the admin key
    this.adminKey = options.adminKey;

    //init array of all module paths
    this.paths = ["/auth"];

    //set the logger
    this.logger = options.logger;

    //init express app
    this.app = this.initExpress(options.port, this.logger);

    //init the redis client
    this.redisClient = initRedis(options.redis, this.logger);

    //connect to mongoose
    initMongo(options.mongoURI, this.logger);

    //init the auth module
    this.auth = initAuth(options, this.redisClient, this.logger);

    //use auth module router
    this.app.use("/api/auth", this.auth.Router);

    //register all modules
    options.modules.forEach((module) => this.addModule(module));
  }

  //get all endpoints
  private getEndPoints() {
    const routes = new Set();
    function print(path: any, layer: any) {
      if (layer.route) {
        layer.route.stack.forEach(
          print.bind(null, path.concat(split(layer.route.path))),
        );
      } else if (layer.name === "router" && layer.handle.stack) {
        layer.handle.stack.forEach(
          print.bind(null, path.concat(split(layer.regexp))),
        );
      } else if (layer.method) {
        routes.add(
          `${layer.method.toUpperCase()} /${path
            .concat(split(layer.regexp))
            .filter(Boolean)
            .join("/")}`,
        );
      }
    }

    function split(thing: any) {
      if (typeof thing === "string") {
        return thing.split("/");
      } else if (thing.fast_slash) {
        return "";
      } else {
        var match = thing
          .toString()
          .replace("\\/?", "")
          .replace("(?=\\/|$)", "$")
          .match(
            /^\/\^((?:\\[.*+?^${}()|[\]\\\/]|[^.*+?^${}()|[\]\\\/])*)\$\//,
          );
        return match
          ? match[1].replace(/\\(.)/g, "$1").split("/")
          : "<complex:" + thing.toString() + ">";
      }
    }

    this.app._router.stack.forEach(print.bind(null, []));

    return Array.from(routes);
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
    this.app.use(join("/api", module.path), module.router);
  }

  //init express app
  private initExpress(port: number, logger: LogFunction) {
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

    //create info route
    app.get("/info", (req, res) => {
      //send error if admin key is wrong
      if (req.query.adminKey !== this.adminKey) {
        return res.status(403).json({
          err: 'Please provide the "adminKey" as a query parameter',
        });
      }

      //send data
      return res.status(200).json({
        modules: this.modules,
        endpoints: this.getEndPoints(),
      });
    });

    //return app
    return app;
  }
}

//init redis client
function initRedis(options: RedisOptions, logger: LogFunction) {
  //create client
  const redis = new RedisClient(options);

  //listen on connection event
  redis.connect(() => {
    logger("info", "Connected to Redis Database!");
  });

  //return redis instance
  return redis;
}

//init mongodb
function initMongo(uri: string, logger: LogFunction) {
  //connect to mongodb
  connect(uri, () => logger("info", "Connected to Mongo Database!"));
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

  //get a user by mail from mongoDB
  auth.use("getUserByMail", async ({ email }) => {
    try {
      //get user from db
      const user = await UserModel.findOne({ email });

      //transform user data
      const userData: IUserData | null = user
        ? {
            email: user.email,
            hashedPassword: user.hashedPassword,
            id: user._id,
            username: user.username,
          }
        : null;

      //return no error
      return [false, userData];
    } catch (err) {
      //log error
      logger("error", String(err));

      //return error
      return [true, null];
    }
  });

  //get a user by name from mongoDB
  auth.use("getUserByName", async ({ username }) => {
    try {
      //get user from db
      const user = await UserModel.findOne({ username });

      //transform user data
      const userData: IUserData | null = user
        ? {
            email: user.email,
            hashedPassword: user.hashedPassword,
            id: user._id,
            username: user.username,
          }
        : null;

      //return no error
      return [false, userData];
    } catch (err) {
      //log error
      logger("error", String(err));

      //return error
      return [true, null];
    }
  });

  //store a user in the mongoDB
  auth.use("storeUser", async ({ email, hashedPassword, username }) => {
    try {
      //create user
      await UserModel.create({
        email: email,
        hashedPassword: hashedPassword,
        username: username,
      });

      //return no error
      return [false];
    } catch (err) {
      //log error
      logger("error", String(err));

      //return error
      return [true];
    }
  });

  //check if a token is in the redis db
  auth.use("checkToken", async ({ token }) => {
    try {
      //check if the token exists
      const included = await redis.sismember(authOptions.tokenSetName, token);

      //return no error
      return [false, Boolean(included)];
    } catch (err) {
      //log error
      logger("error", String(err));

      //return error
      return [true, null];
    }
  });

  //store a token from the redis db
  auth.use("deleteToken", async ({ token }) => {
    try {
      //remove the token
      await redis.srem(authOptions.tokenSetName, token);

      //return no error
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

      //return no error
      return [false];
    } catch (err) {
      //log error
      logger("error", String(err));

      //return error
      return [true];
    }
  });

  //disable (intercept) all registers
  auth.intercept("register", () => [true]);

  //return auth instance
  return auth;
}
