import { handleLayoutRequest, type LayoutWorkerRequest } from "./layoutWorkerCore.ts";

self.onmessage = ({ data }: MessageEvent<LayoutWorkerRequest>) =>
  postMessage(handleLayoutRequest(data));
