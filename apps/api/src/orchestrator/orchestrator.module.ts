import { Module } from '@nestjs/common';
import { SupportCoreModule } from '../support/support.module.js';
import { DeliveriesModule } from '../deliveries/deliveries.module.js';
import { InfraModule } from '../infra/infra.module.js';
import { OrchestratorController, ProvisioningAgentController } from './orchestrator.controller.js';
import { OrchestratorService } from './orchestrator.service.js';
import { ProvisioningEngine } from './engine.js';

/** API: registrar y operar instalaciones, canal del agente (ADR 051). El avance lo hace el worker. */
@Module({
  imports: [InfraModule, DeliveriesModule, SupportCoreModule],
  controllers: [OrchestratorController, ProvisioningAgentController],
  providers: [OrchestratorService, ProvisioningEngine],
  exports: [ProvisioningEngine],
})
export class OrchestratorModule {}

/** Worker: solo el motor (sin rutas) */
@Module({ imports: [InfraModule, SupportCoreModule], providers: [ProvisioningEngine], exports: [ProvisioningEngine] })
export class ProvisioningEngineModule {}
