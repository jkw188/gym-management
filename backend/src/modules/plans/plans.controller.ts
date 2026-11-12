import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { FixedPermission } from '../users/access.policy';
import { CreatePlanDto, CreatePolicyDto, EmptyPlanQueryDto, PlanDto, PlanListQueryDto, PlanPageDto, PlanUpdateResultDto,
  PolicyDto, PolicyListQueryDto, PolicyPageDto, PolicyUpdateResultDto, UpdatePlanDto, UpdatePolicyDto } from './plans.dto';
import { PlansService } from './plans.service';

@ApiTags('Admin plans') @ApiBearerAuth()
@Controller('admin/plans') @FixedPermission('plans.manage')
export class PlansController {
  constructor(private readonly service: PlansService) {}
  @Get() @ApiOkResponse({ type: PlanPageDto })
  list(@Query() query: PlanListQueryDto) { return this.service.list(query); }
  @Get(':id') @ApiOkResponse({ type: PlanDto })
  detail(@Param('id') id: string, @Query() _query: EmptyPlanQueryDto) { return this.service.detail(id); }
  @Post() @ApiCreatedResponse({ type: PlanDto })
  create(@CurrentUser() user: AuthPrincipal, @Body() input: CreatePlanDto, @Query() _query: EmptyPlanQueryDto) { return this.service.create(user.id, input); }
  @Patch(':id') @ApiOkResponse({ type: PlanUpdateResultDto })
  update(@CurrentUser() user: AuthPrincipal, @Param('id') id: string, @Body() input: UpdatePlanDto, @Query() _query: EmptyPlanQueryDto) {
    return this.service.update(user.id, id, input);
  }
}
@ApiTags('Admin plan policies') @ApiBearerAuth()
@Controller('admin/plan-policies') @FixedPermission('planPolicies.manage')
export class PlanPoliciesController {
  constructor(private readonly service: PlansService) {}
  @Get() @ApiOkResponse({ type: PolicyPageDto })
  list(@Query() query: PolicyListQueryDto) { return this.service.listPolicies(query); }
  @Post() @ApiCreatedResponse({ type: PolicyDto })
  create(@CurrentUser() user: AuthPrincipal, @Body() input: CreatePolicyDto, @Query() _query: EmptyPlanQueryDto) { return this.service.createPolicy(user.id, input); }
  @Patch(':id') @ApiOkResponse({ type: PolicyUpdateResultDto })
  update(@CurrentUser() user: AuthPrincipal, @Param('id') id: string, @Body() input: UpdatePolicyDto, @Query() _query: EmptyPlanQueryDto) {
    return this.service.updatePolicy(user.id, id, input);
  }
}
