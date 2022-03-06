import { ModuleConstructor } from "@internal-staff-portal/backend-shared";
import { AuthInstance, IConfig, sendData } from "@authfunctions/express";
import cors from "cors";
import express, {
  Express,
  NextFunction,
  Request,
  request,
  Response,
  response,
} from "express";

type LogLevels = "info" | "warn" | "error" | "debug";

type LogFunction = (level: LogLevels, message: string) => void;

export interface CoreOptions {
  modules: ModuleConstructor[];
  port: number;
  logger: LogFunction;
  auth: IConfig;
}

export class Core {
  private modules: string[];
  private paths: string[];
  private app: Express;
  private auth: AuthInstance;
  private logger: LogFunction;
  constructor(options: CoreOptions) {
    this.modules = ["Auth"];
    this.paths = ["/auth"];
    this.logger = options.logger;
    this.app = initExpress();
    this.auth = new AuthInstance(options.auth);
    this.auth.logger(options.logger);
    this.app.use("/auth", this.auth.Router);
    options.modules.forEach((module) => this.addModule(module));
    this.app.listen(options.port, () =>
      this.logger(
        "info",
        `Internal-Staff-Portal instance on Port ${options.port}!`,
      ),
    );
  }

  private addModule(module: ModuleConstructor) {
    const mod = module({
      auth: {
        sendData: sendData,
        validateMiddleware: this.auth.validateMiddleware,
      },
      logger: this.logger,
    });
    if (this.paths.includes(mod.path) || this.modules.includes(mod.name)) {
      throw new Error(
        `A module with the path "${mod.path}" or the name "${mod.name}" is alredy used!`,
      );
    }

    this.paths.push(mod.path);
    this.modules.push(mod.name);
    this.app.use(mod.path, mod.router);
  }
}

function initExpress() {
  const app = express();
  app.use(express.json());
  app.use(cors());
  return app;
}
