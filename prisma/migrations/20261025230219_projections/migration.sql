-- CreateTable
CREATE TABLE "aggregate_state" (
    "branch_id" UUID NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT,
    "row" JSONB NOT NULL,
    "last_server_seq" BIGINT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "aggregate_state_pkey" PRIMARY KEY ("branch_id","aggregate_type","aggregate_id")
);

-- CreateTable
CREATE TABLE "shift_aliases" (
    "branch_id" UUID NOT NULL,
    "from_shift_id" TEXT NOT NULL,
    "into_shift_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shift_aliases_pkey" PRIMARY KEY ("branch_id","from_shift_id")
);

-- CreateTable
CREATE TABLE "sync_conflicts" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "event_id" UUID NOT NULL,
    "details" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_conflicts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "aggregate_state_branch_id_aggregate_type_status_idx" ON "aggregate_state"("branch_id", "aggregate_type", "status");

-- CreateIndex
CREATE INDEX "sync_conflicts_branch_id_created_at_idx" ON "sync_conflicts"("branch_id", "created_at");

-- AddForeignKey
ALTER TABLE "aggregate_state" ADD CONSTRAINT "aggregate_state_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_aliases" ADD CONSTRAINT "shift_aliases_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_conflicts" ADD CONSTRAINT "sync_conflicts_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
