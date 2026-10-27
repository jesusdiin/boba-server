-- CreateTable
CREATE TABLE "branch_categories" (
    "branch_id" UUID NOT NULL,
    "id" TEXT NOT NULL,
    "name" TEXT,
    "sort_order" INTEGER,
    "is_active" BOOLEAN,
    "version" INTEGER NOT NULL DEFAULT 0,
    "row" JSONB NOT NULL,
    "last_server_seq" BIGINT NOT NULL,

    CONSTRAINT "branch_categories_pkey" PRIMARY KEY ("branch_id","id")
);

-- CreateTable
CREATE TABLE "branch_products" (
    "branch_id" UUID NOT NULL,
    "id" TEXT NOT NULL,
    "category_id" TEXT,
    "name" TEXT,
    "base_price_cents" INTEGER,
    "sort_order" INTEGER,
    "is_active" BOOLEAN,
    "image_path" TEXT,
    "badge" TEXT,
    "is_sold_out" BOOLEAN,
    "version" INTEGER NOT NULL DEFAULT 0,
    "row" JSONB NOT NULL,
    "last_server_seq" BIGINT NOT NULL,

    CONSTRAINT "branch_products_pkey" PRIMARY KEY ("branch_id","id")
);

-- CreateTable
CREATE TABLE "branch_modifier_groups" (
    "branch_id" UUID NOT NULL,
    "id" TEXT NOT NULL,
    "name" TEXT,
    "min_select" INTEGER,
    "max_select" INTEGER,
    "sort_order" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 0,
    "row" JSONB NOT NULL,
    "last_server_seq" BIGINT NOT NULL,

    CONSTRAINT "branch_modifier_groups_pkey" PRIMARY KEY ("branch_id","id")
);

-- CreateTable
CREATE TABLE "branch_modifier_options" (
    "branch_id" UUID NOT NULL,
    "id" TEXT NOT NULL,
    "modifier_group_id" TEXT,
    "name" TEXT,
    "price_delta_cents" INTEGER,
    "sort_order" INTEGER,
    "is_active" BOOLEAN,
    "version" INTEGER NOT NULL DEFAULT 0,
    "row" JSONB NOT NULL,
    "last_server_seq" BIGINT NOT NULL,

    CONSTRAINT "branch_modifier_options_pkey" PRIMARY KEY ("branch_id","id")
);

-- CreateTable
CREATE TABLE "branch_product_modifier_groups" (
    "branch_id" UUID NOT NULL,
    "product_id" TEXT NOT NULL,
    "modifier_group_id" TEXT NOT NULL,
    "sort_order" INTEGER,
    "row" JSONB NOT NULL,
    "last_server_seq" BIGINT NOT NULL,

    CONSTRAINT "branch_product_modifier_groups_pkey" PRIMARY KEY ("branch_id","product_id","modifier_group_id")
);

-- CreateTable
CREATE TABLE "branch_supplies" (
    "branch_id" UUID NOT NULL,
    "id" TEXT NOT NULL,
    "name" TEXT,
    "category" TEXT,
    "unit" TEXT,
    "supplier_name" TEXT,
    "lead_time_hours" INTEGER,
    "min_quantity_milli" INTEGER,
    "unit_cost_cents" INTEGER,
    "sort_order" INTEGER,
    "is_active" BOOLEAN,
    "version" INTEGER NOT NULL DEFAULT 0,
    "row" JSONB NOT NULL,
    "last_server_seq" BIGINT NOT NULL,

    CONSTRAINT "branch_supplies_pkey" PRIMARY KEY ("branch_id","id")
);

-- CreateTable
CREATE TABLE "branch_users" (
    "branch_id" UUID NOT NULL,
    "id" TEXT NOT NULL,
    "display_name" TEXT,
    "role" TEXT,
    "is_active" BOOLEAN,
    "version" INTEGER NOT NULL DEFAULT 0,
    "row" JSONB NOT NULL,
    "last_server_seq" BIGINT NOT NULL,

    CONSTRAINT "branch_users_pkey" PRIMARY KEY ("branch_id","id")
);

-- CreateTable
CREATE TABLE "branch_shifts" (
    "branch_id" UUID NOT NULL,
    "id" TEXT NOT NULL,
    "device_id" TEXT,
    "opened_at_utc" TIMESTAMPTZ(3),
    "opened_business_date" TEXT,
    "starting_cash_cents" INTEGER,
    "closed_at_utc" TIMESTAMPTZ(3),
    "closed_business_date" TEXT,
    "closing_counted_cash_cents" INTEGER,
    "closing_expected_cash_cents" INTEGER,
    "status" TEXT,
    "opened_by_user_id" TEXT,
    "closed_by_user_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "row" JSONB NOT NULL,
    "last_server_seq" BIGINT NOT NULL,

    CONSTRAINT "branch_shifts_pkey" PRIMARY KEY ("branch_id","id")
);

-- CreateTable
CREATE TABLE "branch_sales" (
    "branch_id" UUID NOT NULL,
    "id" TEXT NOT NULL,
    "shift_id" TEXT,
    "device_id" TEXT,
    "business_date" TEXT,
    "subtotal_cents" INTEGER,
    "discount_cents" INTEGER,
    "tax_cents" INTEGER,
    "total_cents" INTEGER,
    "currency_code" TEXT,
    "channel" TEXT,
    "user_id" TEXT,
    "created_at_utc" TIMESTAMPTZ(3),
    "row" JSONB NOT NULL,
    "last_server_seq" BIGINT NOT NULL,

    CONSTRAINT "branch_sales_pkey" PRIMARY KEY ("branch_id","id")
);

-- CreateTable
CREATE TABLE "branch_sale_items" (
    "branch_id" UUID NOT NULL,
    "id" TEXT NOT NULL,
    "sale_id" TEXT NOT NULL,
    "product_id" TEXT,
    "product_name_snapshot" TEXT,
    "unit_price_cents_snapshot" INTEGER,
    "quantity" INTEGER,
    "line_total_cents" INTEGER,
    "created_at_utc" TIMESTAMPTZ(3),
    "row" JSONB NOT NULL,
    "last_server_seq" BIGINT NOT NULL,

    CONSTRAINT "branch_sale_items_pkey" PRIMARY KEY ("branch_id","id")
);

-- CreateTable
CREATE TABLE "branch_sale_item_modifiers" (
    "branch_id" UUID NOT NULL,
    "id" TEXT NOT NULL,
    "sale_item_id" TEXT NOT NULL,
    "modifier_option_id" TEXT,
    "modifier_group_name_snapshot" TEXT,
    "modifier_option_name_snapshot" TEXT,
    "price_delta_cents_snapshot" INTEGER,
    "created_at_utc" TIMESTAMPTZ(3),
    "row" JSONB NOT NULL,
    "last_server_seq" BIGINT NOT NULL,

    CONSTRAINT "branch_sale_item_modifiers_pkey" PRIMARY KEY ("branch_id","id")
);

-- CreateTable
CREATE TABLE "branch_payments" (
    "branch_id" UUID NOT NULL,
    "id" TEXT NOT NULL,
    "sale_id" TEXT NOT NULL,
    "method" TEXT,
    "amount_cents" INTEGER,
    "tendered_cents" INTEGER,
    "change_cents" INTEGER,
    "created_at_utc" TIMESTAMPTZ(3),
    "row" JSONB NOT NULL,
    "last_server_seq" BIGINT NOT NULL,

    CONSTRAINT "branch_payments_pkey" PRIMARY KEY ("branch_id","id")
);

-- CreateTable
CREATE TABLE "branch_cash_movements" (
    "branch_id" UUID NOT NULL,
    "id" TEXT NOT NULL,
    "shift_id" TEXT,
    "device_id" TEXT,
    "business_date" TEXT,
    "kind" TEXT,
    "category" TEXT,
    "concept" TEXT,
    "amount_cents" INTEGER,
    "counterparty" TEXT,
    "user_id" TEXT,
    "created_at_utc" TIMESTAMPTZ(3),
    "row" JSONB NOT NULL,
    "last_server_seq" BIGINT NOT NULL,

    CONSTRAINT "branch_cash_movements_pkey" PRIMARY KEY ("branch_id","id")
);

-- CreateTable
CREATE TABLE "branch_supply_movements" (
    "branch_id" UUID NOT NULL,
    "id" TEXT NOT NULL,
    "supply_id" TEXT NOT NULL,
    "kind" TEXT,
    "quantity_delta_milli" INTEGER,
    "unit_cost_cents" INTEGER,
    "note" TEXT,
    "user_id" TEXT,
    "shift_id" TEXT,
    "device_id" TEXT,
    "business_date" TEXT,
    "created_at_utc" TIMESTAMPTZ(3),
    "row" JSONB NOT NULL,
    "last_server_seq" BIGINT NOT NULL,

    CONSTRAINT "branch_supply_movements_pkey" PRIMARY KEY ("branch_id","id")
);

-- CreateTable
CREATE TABLE "branch_incoming_orders" (
    "branch_id" UUID NOT NULL,
    "id" TEXT NOT NULL,
    "channel" TEXT,
    "customer_name" TEXT,
    "pickup_at_utc" TIMESTAMPTZ(3),
    "status" TEXT,
    "sale_id" TEXT,
    "device_id" TEXT,
    "shift_id" TEXT,
    "created_by_user_id" TEXT,
    "created_at_utc" TIMESTAMPTZ(3),
    "updated_at_utc" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "row" JSONB NOT NULL,
    "last_server_seq" BIGINT NOT NULL,

    CONSTRAINT "branch_incoming_orders_pkey" PRIMARY KEY ("branch_id","id")
);

-- CreateIndex
CREATE INDEX "branch_categories_branch_id_sort_order_idx" ON "branch_categories"("branch_id", "sort_order");

-- CreateIndex
CREATE INDEX "branch_products_branch_id_category_id_sort_order_idx" ON "branch_products"("branch_id", "category_id", "sort_order");

-- CreateIndex
CREATE INDEX "branch_modifier_groups_branch_id_sort_order_idx" ON "branch_modifier_groups"("branch_id", "sort_order");

-- CreateIndex
CREATE INDEX "branch_modifier_options_branch_id_modifier_group_id_sort_or_idx" ON "branch_modifier_options"("branch_id", "modifier_group_id", "sort_order");

-- CreateIndex
CREATE INDEX "branch_product_modifier_groups_branch_id_modifier_group_id_idx" ON "branch_product_modifier_groups"("branch_id", "modifier_group_id");

-- CreateIndex
CREATE INDEX "branch_supplies_branch_id_category_sort_order_idx" ON "branch_supplies"("branch_id", "category", "sort_order");

-- CreateIndex
CREATE INDEX "branch_users_branch_id_role_is_active_idx" ON "branch_users"("branch_id", "role", "is_active");

-- CreateIndex
CREATE INDEX "branch_shifts_branch_id_status_idx" ON "branch_shifts"("branch_id", "status");

-- CreateIndex
CREATE INDEX "branch_shifts_branch_id_opened_business_date_idx" ON "branch_shifts"("branch_id", "opened_business_date");

-- CreateIndex
CREATE INDEX "branch_sales_branch_id_business_date_idx" ON "branch_sales"("branch_id", "business_date");

-- CreateIndex
CREATE INDEX "branch_sales_branch_id_shift_id_idx" ON "branch_sales"("branch_id", "shift_id");

-- CreateIndex
CREATE INDEX "branch_sales_branch_id_created_at_utc_idx" ON "branch_sales"("branch_id", "created_at_utc");

-- CreateIndex
CREATE INDEX "branch_sale_items_branch_id_sale_id_idx" ON "branch_sale_items"("branch_id", "sale_id");

-- CreateIndex
CREATE INDEX "branch_sale_items_branch_id_product_id_idx" ON "branch_sale_items"("branch_id", "product_id");

-- CreateIndex
CREATE INDEX "branch_sale_item_modifiers_branch_id_sale_item_id_idx" ON "branch_sale_item_modifiers"("branch_id", "sale_item_id");

-- CreateIndex
CREATE INDEX "branch_payments_branch_id_sale_id_idx" ON "branch_payments"("branch_id", "sale_id");

-- CreateIndex
CREATE INDEX "branch_payments_branch_id_method_idx" ON "branch_payments"("branch_id", "method");

-- CreateIndex
CREATE INDEX "branch_cash_movements_branch_id_business_date_idx" ON "branch_cash_movements"("branch_id", "business_date");

-- CreateIndex
CREATE INDEX "branch_cash_movements_branch_id_shift_id_idx" ON "branch_cash_movements"("branch_id", "shift_id");

-- CreateIndex
CREATE INDEX "branch_supply_movements_branch_id_supply_id_idx" ON "branch_supply_movements"("branch_id", "supply_id");

-- CreateIndex
CREATE INDEX "branch_supply_movements_branch_id_business_date_idx" ON "branch_supply_movements"("branch_id", "business_date");

-- CreateIndex
CREATE INDEX "branch_incoming_orders_branch_id_status_idx" ON "branch_incoming_orders"("branch_id", "status");

-- CreateIndex
CREATE INDEX "branch_incoming_orders_branch_id_created_at_utc_idx" ON "branch_incoming_orders"("branch_id", "created_at_utc");

-- AddForeignKey
ALTER TABLE "branch_categories" ADD CONSTRAINT "branch_categories_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_products" ADD CONSTRAINT "branch_products_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_modifier_groups" ADD CONSTRAINT "branch_modifier_groups_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_modifier_options" ADD CONSTRAINT "branch_modifier_options_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_product_modifier_groups" ADD CONSTRAINT "branch_product_modifier_groups_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_supplies" ADD CONSTRAINT "branch_supplies_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_users" ADD CONSTRAINT "branch_users_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_shifts" ADD CONSTRAINT "branch_shifts_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_sales" ADD CONSTRAINT "branch_sales_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_sale_items" ADD CONSTRAINT "branch_sale_items_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_sale_item_modifiers" ADD CONSTRAINT "branch_sale_item_modifiers_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_payments" ADD CONSTRAINT "branch_payments_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_cash_movements" ADD CONSTRAINT "branch_cash_movements_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_supply_movements" ADD CONSTRAINT "branch_supply_movements_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_incoming_orders" ADD CONSTRAINT "branch_incoming_orders_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
