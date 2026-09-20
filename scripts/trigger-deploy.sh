#!/bin/bash
set -x

######################################################
# Script that trigger deploy process for api layer   #
# in server side.                                    #
#                                                    #
# Ported verbatim from v1 (scripts/trigger-deploy.sh)#
# except for the branch name: this repository's      #
# default branch is `main`, v1's was `master`. The   #
# SSM document, instance id and entrypoint arguments #
# are unchanged, so the server-side deploy contract  #
# is identical.                                      #
######################################################

if [ "$CODEBUILD_WEBHOOK_EVENT" == 'PUSH' ] && [ "$CODEBUILD_WEBHOOK_HEAD_REF" == 'refs/heads/main' ]; then
	# Triggering deploy process
	echo 'Starting trigger'
	aws ssm send-command \
		--document-name "AWS-RunShellScript" \
		--comment "Deploying api layer" \
		--instance-ids "i-06e827f552c3f56a0" \
		--parameters commands="entrypoint_deploy main api-v2 master" \
		--output text
	echo 'Deploying in background'
	exit 0
fi
