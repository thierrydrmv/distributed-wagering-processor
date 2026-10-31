import { Injectable } from '@nestjs/common';
import type { CanActivate } from '@nestjs/common';

@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(): boolean {
    // Ponto de extensão para validação de identidade via IdP.
    // Autenticação foi explicitamente adiada neste desafio.
    return true;
  }
}
