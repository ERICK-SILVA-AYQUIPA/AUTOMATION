import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Prisma } from '../../generated/prisma/client.js';

/**
 * Respuestas de error uniformes y comprensibles. Nunca se filtran detalles
 * internos (SQL, stack) al cliente; se registran en el log con el requestId.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request & { id?: string }>();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: Record<string, unknown> = { message: 'Error interno. Inténtalo de nuevo.' };

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const r = exception.getResponse();
      body = typeof r === 'string' ? { message: r } : { ...(r as object) };
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        status = HttpStatus.CONFLICT;
        body = { message: 'Ya existe un registro con esos datos', code: 'DUPLICATE' };
      } else if (exception.code === 'P2025') {
        status = HttpStatus.NOT_FOUND;
        body = { message: 'Registro no encontrado' };
      } else if (exception.code === 'P2003') {
        status = HttpStatus.CONFLICT;
        body = { message: 'El registro está relacionado con otros datos', code: 'FK_CONSTRAINT' };
      }
    }
    if (status >= 500) this.log.error({ err: exception, requestId: req.id }, 'Error no controlado');
    res.status(status).json({ statusCode: status, ...body, requestId: req.id });
  }
}
