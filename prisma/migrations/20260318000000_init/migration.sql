-- EnableExtension
CREATE EXTENSION IF NOT EXISTS hstore;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "auth_group" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(150) NOT NULL,

    CONSTRAINT "auth_group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_group_permissions" (
    "id" SERIAL NOT NULL,
    "group_id" INTEGER NOT NULL,
    "permission_id" INTEGER NOT NULL,

    CONSTRAINT "auth_group_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_permission" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "content_type_id" INTEGER NOT NULL,
    "codename" VARCHAR(100) NOT NULL,

    CONSTRAINT "auth_permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_user" (
    "id" SERIAL NOT NULL,
    "password" VARCHAR(128) NOT NULL,
    "last_login" TIMESTAMPTZ(6),
    "is_superuser" BOOLEAN NOT NULL,
    "username" VARCHAR(150) NOT NULL,
    "first_name" VARCHAR(30) NOT NULL,
    "last_name" VARCHAR(150) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "is_staff" BOOLEAN NOT NULL,
    "is_active" BOOLEAN NOT NULL,
    "date_joined" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "auth_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_user_groups" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "group_id" INTEGER NOT NULL,

    CONSTRAINT "auth_user_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_user_user_permissions" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "permission_id" INTEGER NOT NULL,

    CONSTRAINT "auth_user_user_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "authtoken_token" (
    "key" VARCHAR(40) NOT NULL,
    "created" TIMESTAMPTZ(6) NOT NULL,
    "user_id" INTEGER NOT NULL,

    CONSTRAINT "authtoken_token_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "django_content_type" (
    "id" SERIAL NOT NULL,
    "app_label" VARCHAR(100) NOT NULL,
    "model" VARCHAR(100) NOT NULL,

    CONSTRAINT "django_content_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "django_migrations" (
    "id" SERIAL NOT NULL,
    "app" VARCHAR(255) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "applied" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "django_migrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "django_session" (
    "session_key" VARCHAR(40) NOT NULL,
    "session_data" TEXT NOT NULL,
    "expire_date" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "django_session_pkey" PRIMARY KEY ("session_key")
);

-- CreateTable
CREATE TABLE "fondo_api_activity" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "value" BIGINT NOT NULL,
    "date" DATE NOT NULL,
    "year_id" INTEGER NOT NULL,

    CONSTRAINT "fondo_api_activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fondo_api_activityuser" (
    "id" SERIAL NOT NULL,
    "activity_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "state" INTEGER NOT NULL,

    CONSTRAINT "fondo_api_activityuser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fondo_api_activityyear" (
    "id" SERIAL NOT NULL,
    "year" BIGINT NOT NULL,
    "enable" BOOLEAN NOT NULL,

    CONSTRAINT "fondo_api_activityyear_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fondo_api_file" (
    "id" SERIAL NOT NULL,
    "type" INTEGER NOT NULL,
    "display_name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fondo_api_file_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fondo_api_loan" (
    "id" SERIAL NOT NULL,
    "value" BIGINT NOT NULL,
    "timelimit" INTEGER NOT NULL,
    "disbursement_date" DATE NOT NULL,
    "payment" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "fee" INTEGER NOT NULL,
    "comments" TEXT,
    "state" INTEGER NOT NULL,
    "rate" DECIMAL(5,3) NOT NULL,
    "user_id" INTEGER NOT NULL,
    "prev_loan_id" INTEGER,
    "refinanced_loan" BIGINT,
    "disbursement_value" BIGINT,

    CONSTRAINT "fondo_api_loan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fondo_api_loandetail" (
    "id" SERIAL NOT NULL,
    "total_payment" BIGINT NOT NULL,
    "minimum_payment" BIGINT NOT NULL,
    "payday_limit" DATE NOT NULL,
    "interests" BIGINT NOT NULL,
    "capital_balance" BIGINT NOT NULL,
    "from_date" DATE NOT NULL,
    "loan_id" INTEGER NOT NULL,

    CONSTRAINT "fondo_api_loandetail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fondo_api_notificationsubscriptions" (
    "id" SERIAL NOT NULL,
    "subscription" hstore NOT NULL,
    "user_id" INTEGER NOT NULL,

    CONSTRAINT "fondo_api_notificationsubscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fondo_api_power" (
    "id" SERIAL NOT NULL,
    "meeting_date" DATE NOT NULL,
    "state" INTEGER NOT NULL,
    "requestee_id" INTEGER NOT NULL,
    "requester_id" INTEGER NOT NULL,

    CONSTRAINT "fondo_api_power_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fondo_api_savingaccount" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "end_date" DATE NOT NULL,
    "state" INTEGER NOT NULL,
    "value" BIGINT NOT NULL,
    "user_id" INTEGER NOT NULL,

    CONSTRAINT "fondo_api_savingaccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fondo_api_schedulertask" (
    "id" SERIAL NOT NULL,
    "type" INTEGER NOT NULL,
    "run_date" TIMESTAMPTZ(6) NOT NULL,
    "payload" hstore NOT NULL,
    "processed" BOOLEAN NOT NULL,
    "repeat" INTEGER NOT NULL,

    CONSTRAINT "fondo_api_schedulertask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fondo_api_userfinance" (
    "id" SERIAL NOT NULL,
    "contributions" BIGINT NOT NULL,
    "balance_contributions" BIGINT NOT NULL,
    "total_quota" BIGINT NOT NULL,
    "utilized_quota" BIGINT NOT NULL,
    "available_quota" BIGINT NOT NULL,
    "last_modified" DATE NOT NULL,
    "user_id" INTEGER NOT NULL,

    CONSTRAINT "fondo_api_userfinance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fondo_api_userpreference" (
    "id" SERIAL NOT NULL,
    "notifications" BOOLEAN NOT NULL,
    "user_id" INTEGER NOT NULL,
    "primary_color" VARCHAR(15) NOT NULL,
    "secondary_color" VARCHAR(15) NOT NULL,

    CONSTRAINT "fondo_api_userpreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fondo_api_userprofile" (
    "user_ptr_id" INTEGER NOT NULL,
    "identification" BIGINT NOT NULL,
    "role" INTEGER NOT NULL,
    "key_activation" VARCHAR(100),
    "birthdate" DATE,

    CONSTRAINT "fondo_api_userprofile_pkey" PRIMARY KEY ("user_ptr_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "auth_group_name_key" ON "auth_group"("name");

-- CreateIndex
CREATE INDEX "auth_group_name_a6ea08ec_like" ON "auth_group"("name");

-- CreateIndex
CREATE INDEX "auth_group_permissions_group_id_b120cbf9" ON "auth_group_permissions"("group_id");

-- CreateIndex
CREATE INDEX "auth_group_permissions_permission_id_84c5c92e" ON "auth_group_permissions"("permission_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_group_permissions_group_id_permission_id_0cd325b0_uniq" ON "auth_group_permissions"("group_id", "permission_id");

-- CreateIndex
CREATE INDEX "auth_permission_content_type_id_2f476e4b" ON "auth_permission"("content_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_permission_content_type_id_codename_01ab375a_uniq" ON "auth_permission"("content_type_id", "codename");

-- CreateIndex
CREATE UNIQUE INDEX "auth_user_username_key" ON "auth_user"("username");

-- CreateIndex
CREATE INDEX "auth_user_username_6821ab7c_like" ON "auth_user"("username");

-- CreateIndex
CREATE INDEX "auth_user_groups_group_id_97559544" ON "auth_user_groups"("group_id");

-- CreateIndex
CREATE INDEX "auth_user_groups_user_id_6a12ed8b" ON "auth_user_groups"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_user_groups_user_id_group_id_94350c0c_uniq" ON "auth_user_groups"("user_id", "group_id");

-- CreateIndex
CREATE INDEX "auth_user_user_permissions_permission_id_1fbb5f2c" ON "auth_user_user_permissions"("permission_id");

-- CreateIndex
CREATE INDEX "auth_user_user_permissions_user_id_a95ead1b" ON "auth_user_user_permissions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_user_user_permissions_user_id_permission_id_14a6b632_uniq" ON "auth_user_user_permissions"("user_id", "permission_id");

-- CreateIndex
CREATE UNIQUE INDEX "authtoken_token_user_id_key" ON "authtoken_token"("user_id");

-- CreateIndex
CREATE INDEX "authtoken_token_key_10f0b77e_like" ON "authtoken_token"("key");

-- CreateIndex
CREATE UNIQUE INDEX "django_content_type_app_label_model_76bd3d3b_uniq" ON "django_content_type"("app_label", "model");

-- CreateIndex
CREATE INDEX "django_session_expire_date_a5c62663" ON "django_session"("expire_date");

-- CreateIndex
CREATE INDEX "django_session_session_key_c0390e0f_like" ON "django_session"("session_key");

-- CreateIndex
CREATE INDEX "fondo_api_activity_year_id_aed3b367" ON "fondo_api_activity"("year_id");

-- CreateIndex
CREATE INDEX "fondo_api_activityuser_activity_id_d8912768" ON "fondo_api_activityuser"("activity_id");

-- CreateIndex
CREATE INDEX "fondo_api_activityuser_user_id_b53bb1a7" ON "fondo_api_activityuser"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "fondo_api_activityyear_year_key" ON "fondo_api_activityyear"("year");

-- CreateIndex
CREATE UNIQUE INDEX "fondo_api_file_display_name_key" ON "fondo_api_file"("display_name");

-- CreateIndex
CREATE INDEX "fondo_api_file_display_name_4fdf1fd2_like" ON "fondo_api_file"("display_name");

-- CreateIndex
CREATE INDEX "fondo_api_loan_prev_loan_id_9235a32d" ON "fondo_api_loan"("prev_loan_id");

-- CreateIndex
CREATE INDEX "fondo_api_loan_user_id_f4df893f" ON "fondo_api_loan"("user_id");

-- CreateIndex
CREATE INDEX "fondo_api_loandetail_loan_id_6a9fa8c0" ON "fondo_api_loandetail"("loan_id");

-- CreateIndex
CREATE INDEX "fondo_api_notificationsubscriptions_user_id_5954476e" ON "fondo_api_notificationsubscriptions"("user_id");

-- CreateIndex
CREATE INDEX "fondo_api_power_requestee_id_e5f04cf8" ON "fondo_api_power"("requestee_id");

-- CreateIndex
CREATE INDEX "fondo_api_power_requester_id_59064a2c" ON "fondo_api_power"("requester_id");

-- CreateIndex
CREATE INDEX "fondo_api_savingaccount_user_id_b7105f36" ON "fondo_api_savingaccount"("user_id");

-- CreateIndex
CREATE INDEX "fondo_api_userfinance_user_id_9645b2bd" ON "fondo_api_userfinance"("user_id");

-- CreateIndex
CREATE INDEX "fondo_api_userpreference_user_id_c39c1264" ON "fondo_api_userpreference"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "fondo_api_userprofile_identification_key" ON "fondo_api_userprofile"("identification");

-- AddForeignKey
ALTER TABLE "auth_group_permissions" ADD CONSTRAINT "auth_group_permissio_permission_id_84c5c92e_fk_auth_perm" FOREIGN KEY ("permission_id") REFERENCES "auth_permission"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "auth_group_permissions" ADD CONSTRAINT "auth_group_permissions_group_id_b120cbf9_fk_auth_group_id" FOREIGN KEY ("group_id") REFERENCES "auth_group"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "auth_permission" ADD CONSTRAINT "auth_permission_content_type_id_2f476e4b_fk_django_co" FOREIGN KEY ("content_type_id") REFERENCES "django_content_type"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "auth_user_groups" ADD CONSTRAINT "auth_user_groups_group_id_97559544_fk_auth_group_id" FOREIGN KEY ("group_id") REFERENCES "auth_group"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "auth_user_groups" ADD CONSTRAINT "auth_user_groups_user_id_6a12ed8b_fk_auth_user_id" FOREIGN KEY ("user_id") REFERENCES "auth_user"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "auth_user_user_permissions" ADD CONSTRAINT "auth_user_user_permi_permission_id_1fbb5f2c_fk_auth_perm" FOREIGN KEY ("permission_id") REFERENCES "auth_permission"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "auth_user_user_permissions" ADD CONSTRAINT "auth_user_user_permissions_user_id_a95ead1b_fk_auth_user_id" FOREIGN KEY ("user_id") REFERENCES "auth_user"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "authtoken_token" ADD CONSTRAINT "authtoken_token_user_id_35299eff_fk_auth_user_id" FOREIGN KEY ("user_id") REFERENCES "auth_user"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "fondo_api_activity" ADD CONSTRAINT "fondo_api_activity_year_id_aed3b367_fk_fondo_api" FOREIGN KEY ("year_id") REFERENCES "fondo_api_activityyear"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "fondo_api_activityuser" ADD CONSTRAINT "fondo_api_activityus_activity_id_d8912768_fk_fondo_api" FOREIGN KEY ("activity_id") REFERENCES "fondo_api_activity"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "fondo_api_activityuser" ADD CONSTRAINT "fondo_api_activityus_user_id_b53bb1a7_fk_fondo_api" FOREIGN KEY ("user_id") REFERENCES "fondo_api_userprofile"("user_ptr_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "fondo_api_loan" ADD CONSTRAINT "fondo_api_loan_prev_loan_id_9235a32d_fk_fondo_api_loan_id" FOREIGN KEY ("prev_loan_id") REFERENCES "fondo_api_loan"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "fondo_api_loan" ADD CONSTRAINT "fondo_api_loan_user_id_f4df893f_fk_fondo_api" FOREIGN KEY ("user_id") REFERENCES "fondo_api_userprofile"("user_ptr_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "fondo_api_loandetail" ADD CONSTRAINT "fondo_api_loandetail_loan_id_6a9fa8c0_fk_fondo_api_loan_id" FOREIGN KEY ("loan_id") REFERENCES "fondo_api_loan"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "fondo_api_notificationsubscriptions" ADD CONSTRAINT "fondo_api_notificati_user_id_5954476e_fk_fondo_api" FOREIGN KEY ("user_id") REFERENCES "fondo_api_userprofile"("user_ptr_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "fondo_api_power" ADD CONSTRAINT "fondo_api_power_requestee_id_e5f04cf8_fk_fondo_api" FOREIGN KEY ("requestee_id") REFERENCES "fondo_api_userprofile"("user_ptr_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "fondo_api_power" ADD CONSTRAINT "fondo_api_power_requester_id_59064a2c_fk_fondo_api" FOREIGN KEY ("requester_id") REFERENCES "fondo_api_userprofile"("user_ptr_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "fondo_api_savingaccount" ADD CONSTRAINT "fondo_api_savingacco_user_id_b7105f36_fk_fondo_api" FOREIGN KEY ("user_id") REFERENCES "fondo_api_userprofile"("user_ptr_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "fondo_api_userfinance" ADD CONSTRAINT "fondo_api_userfinanc_user_id_9645b2bd_fk_fondo_api" FOREIGN KEY ("user_id") REFERENCES "fondo_api_userprofile"("user_ptr_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "fondo_api_userpreference" ADD CONSTRAINT "fondo_api_userprefer_user_id_c39c1264_fk_fondo_api" FOREIGN KEY ("user_id") REFERENCES "fondo_api_userprofile"("user_ptr_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "fondo_api_userprofile" ADD CONSTRAINT "fondo_api_userprofile_user_ptr_id_9438f85d_fk_auth_user_id" FOREIGN KEY ("user_ptr_id") REFERENCES "auth_user"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
