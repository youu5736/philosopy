import { Router, type IRouter } from "express";
import healthRouter from "./health";
import recommendRouter from "./recommend";

const router: IRouter = Router();

router.use(healthRouter);
router.use(recommendRouter);

export default router;
