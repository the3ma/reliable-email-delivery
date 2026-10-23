#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { buildApp } from '../lib/app';

buildApp(new App());
