import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { FixedPermission } from '../users/access.policy';
import { InvoicesService } from './invoices.service';

@ApiTags('invoices') @ApiBearerAuth() @Controller('invoices')
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}
  @Get(':id') @FixedPermission('invoices.read')
  detail(@Param('id') id: string) { return this.invoices.detail(id); }
}
