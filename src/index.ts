import { Core, CoreOptions } from "./core";

export default function (options: CoreOptions): Core {
  return new Core(options);
}

export { Core, CoreOptions };
